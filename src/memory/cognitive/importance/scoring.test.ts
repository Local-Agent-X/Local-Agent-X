import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreFact, scoreToLevel } from "./scoring.js";
import type { RetainedFact } from "../../types.js";
import { MemoryIndex } from "../../index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function mkFact(over: Partial<RetainedFact>): RetainedFact {
  const now = Date.now();
  return {
    kind: "observation",
    content: "a fact",
    entities: [],
    confidence: 0.7,
    evidenceFor: [],
    evidenceAgainst: [],
    sourceFile: "test",
    sourceLine: 0,
    timestamp: now,
    lastUpdated: now,
    ...over,
  };
}

describe("scoreFact", () => {
  const now = Date.now();

  it("ranks a high-confidence, emotional, entity-rich fact above a sparse low-confidence one", () => {
    const strong = scoreFact(mkFact({
      content: "Peter is grateful and proud of his daughter @maya — a deeply important relationship",
      entities: ["maya", "peter"],
      confidence: 1.0,
      timestamp: now,
    }), now);
    const weak = scoreFact(mkFact({
      content: "saw a bird",
      confidence: 0.5,
      timestamp: now - 60 * DAY_MS,
    }), now);
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it("gives a reinforcement bonus when the fact was re-mentioned after creation", () => {
    const base = mkFact({ content: "Peter's birthday is in June", confidence: 0.9, timestamp: now - 10 * DAY_MS });
    const neverReinforced = scoreFact({ ...base, lastUpdated: base.timestamp }, now);
    const reinforced = scoreFact({ ...base, lastUpdated: now }, now);
    expect(reinforced.score).toBeGreaterThan(neverReinforced.score);
    expect(reinforced.factors.reinforcement).toBe(100);
    expect(neverReinforced.factors.reinforcement).toBe(0);
  });

  it("anchors recency on creation timestamp, not lastUpdated (no 'reinforced = fresh' bug)", () => {
    const old = now - 90 * DAY_MS;
    const s = scoreFact(mkFact({ timestamp: old, lastUpdated: now }), now);
    // 90 days at a 14-day half-life ≈ 0.01% recency — must stay near zero even
    // though lastUpdated is "now".
    expect(s.factors.recency).toBeLessThan(5);
  });

  it("maps scores to levels at the documented thresholds", () => {
    expect(scoreToLevel(85)).toBe("critical");
    expect(scoreToLevel(60)).toBe("high");
    expect(scoreToLevel(35)).toBe("medium");
    expect(scoreToLevel(15)).toBe("low");
    expect(scoreToLevel(5)).toBe("archive");
  });
});

describe("MemoryIndex.topImportantFacts", () => {
  let tempDir: string;
  let memory: MemoryIndex;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lax-imp-"));
    mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
    memory = new MemoryIndex(tempDir, { minScore: -1 });
  });
  afterEach(() => {
    try { memory.close(); } catch { /* noop */ }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it("returns facts ranked by importance, highest first, across all kinds", () => {
    const high = memory.rememberFact("Peter loves his daughter Maya more than anything", { kind: "observation", confidence: 1.0 });
    const low = memory.rememberFact("the sky was grey", { kind: "observation", confidence: 0.5 });
    const opinion = memory.rememberFact("Peter thinks TypeScript is fine", { kind: "opinion", confidence: 0.8 });
    expect(high.ok && low.ok && opinion.ok).toBe(true);

    const ranked = memory.topImportantFacts(10);
    expect(ranked.length).toBe(3);
    // Sorted descending by score.
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].importance.score).toBeGreaterThanOrEqual(ranked[i].importance.score);
    }
    // The emotional, max-confidence fact outranks the sparse low-confidence one.
    const highRank = ranked.findIndex(r => r.fact.content.includes("Maya"));
    const lowRank = ranked.findIndex(r => r.fact.content.includes("grey"));
    expect(highRank).toBeLessThan(lowRank);
    // Opinion kind is included (recallRecentFacts would have excluded it).
    expect(ranked.some(r => r.fact.kind === "opinion")).toBe(true);
  });
});
