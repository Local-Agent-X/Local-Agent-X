/**
 * Regression tests for recallRecentFacts candidate-window sizing.
 *
 * Bug: the SQL pre-filter pulled `LIMIT 3*limit` candidates ordered by
 * last_updated DESC, then JS-reranked by hot_score (confidence × decay).
 * In a real user's DB (hundreds of recently-reinforced low-confidence
 * facts) the 3× window was entirely consumed by recency-ordered chatter,
 * so high-confidence older facts the rerank was *designed* to surface
 * never entered the window in the first place. Fix widened the candidate
 * pool so the rerank has meaningful selection.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../memory.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-recall-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// rememberFact stamps timestamp/last_updated with Date.now(); these tests
// need to simulate facts created/reinforced at arbitrary epoch-ms values.
function setFactClock(factId: number, timestamp: number, lastUpdated: number): void {
  const db = memory["db"];
  db.prepare("UPDATE facts SET timestamp = ?, last_updated = ? WHERE id = ?")
    .run(timestamp, lastUpdated, factId);
}

describe("recallRecentFacts candidate-window sizing", () => {
  // THE BUG REPRO: a high-confidence fact older than the candidate-window
  // threshold should still surface in the result. With the old 3×limit
  // window, hundreds of recent low-confidence facts truncated the old
  // high-confidence one out before the rerank ever saw it.
  it("surfaces a high-confidence old fact past hundreds of recent low-confidence facts", () => {
    const now = Date.now();

    // 250 low-confidence recent observations. Spread over the past 7 days
    // so last_updated values are distinct and ordered, mimicking a real DB.
    for (let i = 0; i < 250; i++) {
      const r = memory.rememberFact(`noise observation number ${i}`, {
        kind: "observation",
        confidence: 0.5,
      });
      expect(r.ok).toBe(true);
      const ts = now - Math.floor((i / 250) * 7 * DAY_MS);
      setFactClock(r.fact!.id!, ts, ts);
    }

    // 1 high-confidence world fact, 15 days old. Hot-score at half_life=30:
    //   1.0 * exp(-15/30) ≈ 0.607
    // beats the recent noise (0.5 * exp(-~3/30) ≈ 0.45), so once the
    // candidate window includes it, the rerank places it at the top.
    const r = memory.rememberFact("durable critical knowledge worth keeping", {
      kind: "world",
      confidence: 1.0,
    });
    expect(r.ok).toBe(true);
    const oldFactId = r.fact!.id!;
    const fifteenDaysAgo = now - 15 * DAY_MS;
    setFactClock(oldFactId, fifteenDaysAgo, fifteenDaysAgo);

    const result = memory.recallRecentFacts({
      limit: 60,
      kinds: ["observation", "world"],
    });

    expect(result.map((f) => f.id)).toContain(oldFactId);
  });

  it("orders results by hot_score, not last_updated", () => {
    const now = Date.now();

    // Five facts laid out so hot_score order ≠ last_updated order.
    // Hot scores at half_life=30:
    //   A: conf=1.0, age=2d  → 1.0 * exp(-2/30)  ≈ 0.936
    //   B: conf=0.6, age=1d  → 0.6 * exp(-1/30)  ≈ 0.580  (newest)
    //   C: conf=1.0, age=20d → 1.0 * exp(-20/30) ≈ 0.513
    //   D: conf=0.7, age=10d → 0.7 * exp(-10/30) ≈ 0.502
    //   E: conf=0.5, age=5d  → 0.5 * exp(-5/30)  ≈ 0.423  (mid age)
    // last_updated DESC ordering would be: B, A, E, D, C.
    // hot_score DESC ordering should be:   A, B, C, D, E.
    const specs = [
      { content: "fact a high conf recent", conf: 1.0, ageDays: 2 },
      { content: "fact b mid conf newest", conf: 0.6, ageDays: 1 },
      { content: "fact c high conf old", conf: 1.0, ageDays: 20 },
      { content: "fact d mid conf mid age", conf: 0.7, ageDays: 10 },
      { content: "fact e low conf mid age", conf: 0.5, ageDays: 5 },
    ];
    const ids: number[] = [];
    for (const s of specs) {
      const r = memory.rememberFact(s.content, { kind: "observation", confidence: s.conf });
      expect(r.ok).toBe(true);
      const ts = now - s.ageDays * DAY_MS;
      setFactClock(r.fact!.id!, ts, ts);
      ids.push(r.fact!.id!);
    }

    const result = memory.recallRecentFacts({ limit: 10, kinds: ["observation"] });

    // Expected hot_score DESC: a, b, c, d, e
    expect(result.map((f) => f.content)).toEqual([
      "fact a high conf recent",
      "fact b mid conf newest",
      "fact c high conf old",
      "fact d mid conf mid age",
      "fact e low conf mid age",
    ]);
  });

  it("dedups same-(kind,primary-entity) facts after rerank — highest hot_score wins", () => {
    const now = Date.now();

    // Two observations about @alice. Different content (avoids the UNIQUE
    // index and any contradiction sweep), same kind, same primary entity.
    // The dedup-on-recall block collapses these to the higher-hot-score one.
    const rHigh = memory.rememberFact("loves morning coffee @alice", {
      kind: "observation",
      confidence: 1.0,
    });
    expect(rHigh.ok).toBe(true);
    const highId = rHigh.fact!.id!;
    setFactClock(highId, now - 2 * DAY_MS, now - 2 * DAY_MS);

    const rLow = memory.rememberFact("drinks evening tea @alice", {
      kind: "observation",
      confidence: 0.5,
    });
    expect(rLow.ok).toBe(true);
    const lowId = rLow.fact!.id!;
    setFactClock(lowId, now - 1 * DAY_MS, now - 1 * DAY_MS);

    const result = memory.recallRecentFacts({ limit: 10, kinds: ["observation"] });

    const ids = result.map((f) => f.id);
    expect(ids).toContain(highId);
    expect(ids).not.toContain(lowId);
    // Result count must still respect the limit (sanity check that the
    // wider candidate pool didn't break the slice in the dedup loop).
    expect(result.length).toBeLessThanOrEqual(10);
  });
});
