import { describe, it, expect } from "vitest";
import { DETECTORS } from "./registry.js";
import { DEFAULT_RETRY_BUDGET, createRetryCounters } from "./budget.js";
import { runPostTurnDetectors } from "./orchestrator.js";
import type { TurnState } from "./state.js";

function turn(over: Partial<TurnState>): TurnState {
  return {
    assistantText: "",
    toolCallsThisIteration: [],
    toolsCalledThisTurn: new Set(),
    hasReasoning: false,
    completionTokens: 0,
    iteration: 1,
    evidenceCount: 0,
    evidenceHistory: [],
    ...over,
  };
}

// These pin the values the registry derives. RetryBudget / RetryCounters /
// DEFAULT_RETRY_BUDGET / createRetryCounters and the orchestrator run order all
// flow from DETECTORS now, so a silent drift in that array would shift behavior
// without tripping a detector's own unit test — this file is that net.
describe("detector registry — derived budgets & counters", () => {
  it("derives DEFAULT_RETRY_BUDGET from the registry, one entry per detector", () => {
    expect(DEFAULT_RETRY_BUDGET).toEqual({
      "incomplete-multistep": 8,
      "planning-only": 2,
      "single-action-stop": 2,
      "reasoning-only": 2,
      "empty-response": 2,
      "uncommitted-turn": 1,
      "evidence-stale": 1,
    });
  });

  it("seeds counters at zero for exactly the registered kinds", () => {
    const counters = createRetryCounters();
    expect(counters).toEqual({
      "incomplete-multistep": 0,
      "planning-only": 0,
      "single-action-stop": 0,
      "reasoning-only": 0,
      "empty-response": 0,
      "uncommitted-turn": 0,
      "evidence-stale": 0,
    });
  });

  it("marks exactly the vision-misfiring detectors as skipOnImages", () => {
    const skipped = DETECTORS.filter(d => d.skipOnImages).map(d => d.kind).sort();
    expect(skipped).toEqual(["evidence-stale", "planning-only", "uncommitted-turn"]);
  });
});

describe("detector registry — run order", () => {
  it("runs incomplete-multistep first", () => {
    expect(DETECTORS[0].kind).toBe("incomplete-multistep");
  });

  it("incomplete-multistep wins over planning-only when both fire", () => {
    // "Next, I'll write …" trips planning-only; "Step 2" of 3 trips
    // incomplete-multistep. The registry order decides which nudge is returned.
    const state = turn({
      assistantText: "Step 2 done. Next, I'll write the final file.",
      enumeratedSteps: 3,
    });
    const hit = runPostTurnDetectors(state, createRetryCounters());
    expect(hit?.kind).toBe("incomplete-multistep");
  });
});
