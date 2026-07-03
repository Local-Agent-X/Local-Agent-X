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

describe("detectSingleActionStop — fires only on the ending iteration", () => {
  // The bug (HE-6): requiring exactly one PENDING exploratory call meant the
  // detector only ever fired mid-flight — the loop was still running and the
  // model was about to follow through on its own. A research worker doing one
  // web_search per iteration with normal "then/next" narration got
  // "Do not re-explore. Act." injected into a healthy turn.
  it("does not fire while an exploratory call is still pending", () => {
    const state = turn({
      assistantText: "Searching for the schedule. Then I'll compile the answer.",
      toolCallsThisIteration: [{ name: "web_search", arguments: JSON.stringify({ query: "schedule" }) }],
      toolsCalledThisTurn: new Set(["web_search"]),
    });
    expect(detectSingleActionStop(state)).toBeNull();
  });

  it.each([
    "cat src/index.ts",
    "sleep 70 && date",
    "npm run build",
  ])("does not fire for a pending bash call %j — mid-flight is never a stall", (cmd) => {
    expect(detectSingleActionStop(bashTurn(cmd))).toBeNull();
  });

  it("fires when the turn ends after one exploratory tool with an unmet promise", () => {
    const state = turn({
      assistantText: "Read the file. Next, I'll edit it.",
      toolsCalledThisTurn: new Set(["read"]),
    });
    expect(detectSingleActionStop(state)?.kind).toBe("single-action-stop");
  });

  it("fires on a sentence-leading continuation cue without a first-person promise", () => {
    const state = turn({
      assistantText: "Found the config. Next: update the port.",
      toolsCalledThisTurn: new Set(["grep"]),
    });
    expect(detectSingleActionStop(state)?.kind).toBe("single-action-stop");
  });

  it("does not fire on a mid-sentence continuation word in descriptive prose", () => {
    const state = turn({
      assistantText: "The launch happens next Tuesday at 9am, per the announcement.",
      toolsCalledThisTurn: new Set(["web_search"]),
    });
    expect(detectSingleActionStop(state)).toBeNull();
  });

  it("does not fire for an ended bash-only turn — command no longer inspectable", () => {
    const state = turn({
      assistantText: "Listed the files. Next, I'll pick one.",
      toolsCalledThisTurn: new Set(["bash"]),
    });
    expect(detectSingleActionStop(state)).toBeNull();
  });

  it("does not fire when the turn used more than one distinct tool", () => {
    const state = turn({
      assistantText: "Read the file and searched the repo. Then I verified.",
      toolsCalledThisTurn: new Set(["read", "grep"]),
    });
    expect(detectSingleActionStop(state)).toBeNull();
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
