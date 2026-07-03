import { describe, it, expect, vi, beforeEach } from "vitest";

// The Facts DB is mocked so signalsFor() runs against a controlled fact set
// instead of the real universal index — nothing here touches disk or memory.
const recallRecentFacts = vi.fn<() => { content: string }[]>(() => []);
vi.mock("./memory/universal-index.js", () => ({
  getUniversalIndex: () => ({
    getMemory: () => ({ recallRecentFacts }),
  }),
}));

import { ContradictionDetector } from "./contradiction-detector.js";

// The veto layer in orchestrator/signals-meta.ts escalates a contradiction
// signal to a priority-9 turn override iff `sig.confidence >= 0.8`. This
// mirrors that threshold so the tests assert veto behavior, not a magic number.
const VETO_THRESHOLD = 0.8;

describe("ContradictionDetector.signalsFor — confidence carries the per-detection score", () => {
  beforeEach(() => {
    recallRecentFacts.mockReset();
  });

  it("does NOT emit a veto-strength signal for a loose false-positive contradiction", () => {
    // "like" is a loose preference extractor: two unrelated statements collide
    // on the shared token "like" (overlap 0.5) but reference different values
    // (pizza vs Sarah). checkContradiction fires, but its computed confidence is
    // ~0.65 — below the 0.8 veto threshold. The pre-fix code hardcoded 0.8 here,
    // so this benign phrasing mismatch became a guaranteed priority-9 override.
    recallRecentFacts.mockReturnValue([{ content: "I like Sarah" }]);

    const signals = ContradictionDetector.getInstance().signalsFor("I like pizza");

    expect(signals).toHaveLength(1);
    expect(signals[0].category).toBe("contradiction");
    expect(signals[0].confidence).toBeLessThan(VETO_THRESHOLD);
  });

  it("still emits a veto-strength signal for a high-overlap genuine contradiction", () => {
    // A real location flip with high surrounding-keyword overlap clears the
    // threshold, so genuine contradictions still escalate.
    recallRecentFacts.mockReturnValue([{ content: "I moved to Denver this year" }]);

    const signals = ContradictionDetector.getInstance().signalsFor("I moved to Boston this year");

    expect(signals).toHaveLength(1);
    expect(signals[0].confidence).toBeGreaterThanOrEqual(VETO_THRESHOLD);
  });
});
