import { describe, it, expect } from "vitest";
import { detectSingleActionStop, detectIncompleteMultiStep } from "./detectors.js";
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

function bashTurn(command: string): TurnState {
  return turn({
    assistantText: "Ran step 1. Next, I'll do step 2.",
    toolCallsThisIteration: [{ name: "bash", arguments: JSON.stringify({ command }) }],
  });
}

describe("detectSingleActionStop — arg-aware bash", () => {
  // The bug: a committing bash step (sleep/npm/git) that summarizes its one
  // action is real sequential work, not a stall — it must NOT be nudged with
  // "do not summarize, act", which is what suppressed per-step narration.
  it.each([
    "sleep 70 && date",
    "npm run build",
    "git commit -m wip",
  ])("does not fire for committing bash command %j", (cmd) => {
    expect(detectSingleActionStop(bashTurn(cmd))).toBeNull();
  });

  // Read-only bash exploration that stalls mid-promise still gets the nudge.
  it.each([
    "cat src/index.ts",
    "grep -rn foo src/",
  ])("still fires for read-only bash command %j", (cmd) => {
    const hit = detectSingleActionStop(bashTurn(cmd));
    expect(hit?.kind).toBe("single-action-stop");
  });

  it("defaults to non-exploratory when bash args are unparseable", () => {
    const state = turn({
      assistantText: "Ran step 1. Next, I'll do step 2.",
      toolCallsThisIteration: [{ name: "bash", arguments: "{not json" }],
    });
    expect(detectSingleActionStop(state)).toBeNull();
  });

  // A non-bash exploratory tool is unaffected by the bash gate.
  it("still fires for a single read tool that stalls", () => {
    const state = turn({
      assistantText: "Read the file. Next, I'll edit it.",
      toolCallsThisIteration: [{ name: "read", arguments: JSON.stringify({ path: "x" }) }],
    });
    expect(detectSingleActionStop(state)?.kind).toBe("single-action-stop");
  });
});

describe("detectIncompleteMultiStep", () => {
  // The observed failure: Grok/Codex run step 1 of a 3-step task, summarize,
  // and yield. The harness must drive them onward without forbidding summaries.
  it("fires when the model finished step 1 of 3 and yielded", () => {
    const state = turn({
      assistantText: "Step 1 complete: I ran `sleep 70 && date`. Returned Wed Jun 3 20:03:13.",
      enumeratedSteps: 3,
    });
    expect(detectIncompleteMultiStep(state)?.kind).toBe("incomplete-multistep");
  });

  it("does not fire once the final step is reached", () => {
    const state = turn({
      assistantText: "Step 3 complete. Final report: all three runs succeeded.",
      enumeratedSteps: 3,
    });
    expect(detectIncompleteMultiStep(state)).toBeNull();
  });

  it("does not fire for a single-step request", () => {
    const state = turn({ assistantText: "Step 1 complete.", enumeratedSteps: 0 });
    expect(detectIncompleteMultiStep(state)).toBeNull();
  });

  it("does not fire while the model is still calling tools", () => {
    const state = turn({
      assistantText: "Step 1 done, running step 2 now.",
      enumeratedSteps: 3,
      toolCallsThisIteration: [{ name: "bash", arguments: JSON.stringify({ command: "sleep 70 && date" }) }],
    });
    expect(detectIncompleteMultiStep(state)).toBeNull();
  });

  it("does not fire when the reply names no step", () => {
    const state = turn({ assistantText: "I ran the command and it worked.", enumeratedSteps: 3 });
    expect(detectIncompleteMultiStep(state)).toBeNull();
  });

  it("stands down when the model is waiting on the user", () => {
    const state = turn({
      assistantText: "Step 1 complete. Which step would you like me to do next?",
      enumeratedSteps: 3,
    });
    expect(detectIncompleteMultiStep(state)).toBeNull();
  });
});
