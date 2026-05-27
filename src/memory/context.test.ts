/**
 * Regression tests for the <core_memory> "still fresh" salience tag.
 *
 * Bug: the freshness window check and the displayed date both keyed off
 * `lastUpdated`, which `reinforceFacts()` bumps every time the entity is
 * mentioned. So an old biographical event (e.g. "Rex died on March 1") would
 * re-render as today's date with " — still fresh" the next time the user
 * said "Rex" months later. The fix anchors both on `timestamp` (creation
 * time, immutable) instead of `lastUpdated`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../memory.js";
import { buildContextBlock } from "./context.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-ctx-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// Helper: insert a fact and then force its timestamp/last_updated columns to
// arbitrary epoch-ms values. rememberFact stamps both with Date.now(); for
// these tests we need to simulate "fact created N days ago, optionally
// reinforced today."
function setFactClock(factId: number, timestamp: number, lastUpdated: number): void {
  const db = memory["db"];
  db.prepare("UPDATE facts SET timestamp = ?, last_updated = ? WHERE id = ?")
    .run(timestamp, lastUpdated, factId);
}

function extractCoreMemory(block: string): string {
  const m = block.match(/<core_memory>[\s\S]*?<\/core_memory>/);
  return m ? m[0] : "";
}

describe("<core_memory> 'still fresh' salience", () => {
  it("renders the creation date with no 'still fresh' suffix for an old, never-reinforced experience", async () => {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * DAY_MS;

    const r = memory.rememberFact("Rex the dog died", { kind: "experience", confidence: 1.0 });
    expect(r.ok).toBe(true);
    setFactClock(r.fact!.id!, thirtyDaysAgo, thirtyDaysAgo);

    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const core = extractCoreMemory(block);

    const expectedDate = new Date(thirtyDaysAgo).toISOString().slice(0, 10);
    expect(core).toContain(`${expectedDate}: Rex the dog died`);
    expect(core).not.toContain("still fresh");
  });

  it("flags a recently-created, never-reinforced experience as 'still fresh'", async () => {
    const now = Date.now();
    const threeDaysAgo = now - 3 * DAY_MS;

    const r = memory.rememberFact("Started Calenbella build", { kind: "experience", confidence: 1.0 });
    expect(r.ok).toBe(true);
    setFactClock(r.fact!.id!, threeDaysAgo, threeDaysAgo);

    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const core = extractCoreMemory(block);

    const expectedDate = new Date(threeDaysAgo).toISOString().slice(0, 10);
    expect(core).toContain(`${expectedDate}: Started Calenbella build`);
    expect(core).toContain("still fresh");
  });

  // THE BUG: a 30-day-old fact reinforced today should keep its old creation
  // date and stay out of the freshness window. Before the fix this rendered
  // today's date + "still fresh" because both signals used last_updated.
  it("does NOT flag an old experience as 'still fresh' when only last_updated was bumped (the bug)", async () => {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * DAY_MS;
    const todayMs = now;

    const r = memory.rememberFact("Rex the dog died", { kind: "experience", confidence: 1.0 });
    expect(r.ok).toBe(true);
    // Simulate: created 30 days ago, reinforced (last_updated bumped) today.
    setFactClock(r.fact!.id!, thirtyDaysAgo, todayMs);

    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const core = extractCoreMemory(block);

    const oldDate = new Date(thirtyDaysAgo).toISOString().slice(0, 10);
    const todayDate = new Date(todayMs).toISOString().slice(0, 10);
    expect(core).toContain(`${oldDate}: Rex the dog died`);
    expect(core).not.toContain(`${todayDate}: Rex the dog died`);
    expect(core).not.toContain("still fresh");
  });

  it("does not add a date prefix or 'still fresh' suffix to non-experience kinds", async () => {
    const now = Date.now();

    const r = memory.rememberFact("prefers oat milk", { kind: "opinion", confidence: 1.0 });
    expect(r.ok).toBe(true);
    setFactClock(r.fact!.id!, now, now);

    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const core = extractCoreMemory(block);

    expect(core).toContain("prefers oat milk");
    const todayDate = new Date(now).toISOString().slice(0, 10);
    expect(core).not.toContain(`${todayDate}: prefers oat milk`);
    expect(core).not.toContain("still fresh");
  });
});

/**
 * Coverage for the three other load-bearing behaviors of the <core_memory>
 * render path (in addition to the freshness suite above):
 *
 *   1. 3 KB body cap — bounds prompt cost when the Facts DB grows large
 *   2. Heading order + empty-bucket skip — controls how the model reads it
 *   3. Entity reinforcement — mentioning an entity in this turn's user
 *      message bumps last_updated on its facts BEFORE recall, so reinforced
 *      facts sort to the top of the same turn's render ("human memory" pattern)
 */
describe("<core_memory> cap / heading order / reinforcement", () => {
  it("body cap holds under flood — never wildly exceeds MAX_BYTES=3000", async () => {
    const now = Date.now();
    // 50 facts, ~120 char content each, spread across kinds so no single
    // bucket dominates. All recent + high-confidence so all qualify under
    // the recall filter (minConfidence=0.4) and the freshness window.
    const kinds = ["world", "opinion", "observation"] as const;
    for (let i = 0; i < 50; i++) {
      const padding = "x".repeat(80);
      const r = memory.rememberFact(`flood fact number ${i} ${padding}`, {
        kind: kinds[i % kinds.length],
        confidence: 0.9,
      });
      expect(r.ok).toBe(true);
      // Distinct timestamps so dedup-on-recall doesn't merge them.
      const ts = now - i * 1000;
      setFactClock(r.fact!.id!, ts, ts);
    }

    // No userMessage → no entity reinforcement noise affects ordering.
    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const core = extractCoreMemory(block);

    // Cap is checked AFTER incrementing bodyBytes but BEFORE pushing the
    // offending line, so pushed content is strictly under MAX_BYTES. The
    // wrapper (`<core_memory>` tags + ~200-char header + up to 4 headings)
    // adds ~400 bytes of envelope, so 3500 total is the generous upper bound.
    expect(core.length).toBeLessThan(3500);

    const bulletLines = (core.match(/^- /gm) || []).length;
    // Cap forces an early break before all 50 fit (each line ~120 bytes →
    // ~25 lines fit in 3000 bytes).
    expect(bulletLines).toBeLessThan(50);
    expect(bulletLines).toBeGreaterThan(0);
  });

  it("renders headings in fixed order: world → opinion → experience → observation", async () => {
    const now = Date.now();
    const inserts: Array<["world" | "opinion" | "experience" | "observation", string]> = [
      ["world", "owns NutriShop McKinney"],
      ["opinion", "prefers responses without filler"],
      ["experience", "shipped Calenbella last week"],
      ["observation", "writes commits in past tense"],
    ];
    for (const [kind, content] of inserts) {
      const r = memory.rememberFact(content, { kind, confidence: 0.9 });
      expect(r.ok).toBe(true);
      setFactClock(r.fact!.id!, now, now);
    }

    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const core = extractCoreMemory(block);

    const headings = [
      "Things you know about them",   // world
      "How they like things",         // opinion
      "Recent in their life",         // experience
      "Other notes",                  // observation
    ];
    const indices = headings.map((h) => core.indexOf(h));
    // All four present.
    for (let i = 0; i < headings.length; i++) {
      expect(indices[i], `heading "${headings[i]}" missing`).toBeGreaterThan(-1);
    }
    // Strictly increasing — order is fixed regardless of insert order.
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });

  it("skips empty buckets entirely — no orphan headings", async () => {
    const now = Date.now();
    const r1 = memory.rememberFact("owns NutriShop McKinney", { kind: "world", confidence: 0.9 });
    expect(r1.ok).toBe(true);
    setFactClock(r1.fact!.id!, now, now);
    const r2 = memory.rememberFact("shipped Calenbella last week", { kind: "experience", confidence: 0.9 });
    expect(r2.ok).toBe(true);
    setFactClock(r2.fact!.id!, now, now);

    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const core = extractCoreMemory(block);

    expect(core).toContain("Things you know about them"); // world bucket
    expect(core).toContain("Recent in their life");       // experience bucket
    expect(core).not.toContain("How they like things");   // opinion (empty)
    expect(core).not.toContain("Other notes");            // observation (empty)
  });

  it("entity reinforcement bumps last_updated BEFORE recall — buried fact surfaces", async () => {
    const now = Date.now();
    const sixtyDaysAgo = now - 60 * DAY_MS;

    // Buried target: 60d old, high confidence, tagged @peter. Hot-score
    // without reinforcement ≈ 0.9 * exp(-60/30) ≈ 0.122 — loses to the 0.6
    // hot-score of every fresh filler.
    const rA = memory.rememberFact("loves hiking @peter", {
      kind: "observation",
      confidence: 0.9,
    });
    expect(rA.ok).toBe(true);
    const factAId = rA.fact!.id!;
    setFactClock(factAId, sixtyDaysAgo, sixtyDaysAgo);

    // 70 fresh filler facts at confidence 0.6 — high enough to pass the
    // minConfidence=0.4 floor, dense enough to flood the top-N without
    // reinforcement.
    for (let i = 0; i < 70; i++) {
      const r = memory.rememberFact(`filler observation number ${i}`, {
        kind: "observation",
        confidence: 0.6,
      });
      expect(r.ok).toBe(true);
      const ts = now - i * 100;
      setFactClock(r.fact!.id!, ts, ts);
    }

    // Sanity: confirm @peter is in entity_mentions so the substring filter
    // (slug length ≥ 3, present in user message) will match.
    const slugRow = memory["db"]
      .prepare("SELECT entity_slug FROM entity_mentions WHERE fact_id = ?")
      .get(factAId) as { entity_slug: string } | undefined;
    expect(slugRow?.entity_slug).toBe("peter");

    const block = await buildContextBlock(memory, {
      skipDailyLog: true,
      userMessage: "let's talk about peter",
    });
    const core = extractCoreMemory(block);

    // Fact A's persisted content is "loves hiking" (@-entity stripped).
    expect(core).toContain("loves hiking");
    // And it should appear EARLIER than at least one filler fact —
    // proof that reinforcement moved it to the top of hot-score order,
    // not just that the bigger candidate window happened to include it.
    const factAIdx = core.indexOf("loves hiking");
    const firstFillerIdx = core.indexOf("filler observation number");
    if (firstFillerIdx !== -1) {
      expect(factAIdx).toBeLessThan(firstFillerIdx);
    }
  });

  it("entity reinforcement does NOT fire when user message mentions no known entity", async () => {
    const now = Date.now();
    const sixtyDaysAgo = now - 60 * DAY_MS;
    const rA = memory.rememberFact("loves hiking @peter", {
      kind: "observation",
      confidence: 0.9,
    });
    expect(rA.ok).toBe(true);
    const factAId = rA.fact!.id!;
    setFactClock(factAId, sixtyDaysAgo, sixtyDaysAgo);

    const db = memory["db"];
    const before = db
      .prepare("SELECT last_updated FROM facts WHERE id = ?")
      .get(factAId) as { last_updated: number };
    expect(before.last_updated).toBe(sixtyDaysAgo);

    await buildContextBlock(memory, {
      skipDailyLog: true,
      userMessage: "let's talk about something else entirely",
    });

    const after = db
      .prepare("SELECT last_updated FROM facts WHERE id = ?")
      .get(factAId) as { last_updated: number };
    // No entity match → no reinforceFacts call → last_updated untouched.
    expect(after.last_updated).toBe(sixtyDaysAgo);
  });

  it("omits the <core_memory> block entirely when no facts qualify", async () => {
    // Only low-confidence facts (below minConfidence=0.4 floor). Recall
    // returns empty → the whole render block is skipped.
    const r = memory.rememberFact("noise below confidence floor", {
      kind: "observation",
      confidence: 0.2,
    });
    expect(r.ok).toBe(true);

    const block = await buildContextBlock(memory, { skipDailyLog: true });

    expect(block).not.toContain("<core_memory>");
    expect(block).not.toContain("</core_memory>");
  });
});
