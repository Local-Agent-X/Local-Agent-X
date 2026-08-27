import { describe, it, expect } from "vitest";
import { detectEvidenceStale, type TurnState } from "../src/agent-loop-detectors/index.js";

// Regression: detectEvidenceStale used to fire even when the agent had just
// emitted a tool call this iteration. The orchestrator would push the
// assistant.tool_calls to messages, the detector would fire, and the loop
// would `continue` — skipping executeToolCalls. Next API request rejected
// with 400 "No tool output found for function call" because the assistant
// referenced a tool_call_id with no matching tool result.
//
// Symptom in production: "give me my instagram stats" on Codex opened the
// browser tool, then aborted. Anthropic on the same prompt called browser
// 11 times and produced an answer. Same detector code, but Anthropic's
// adapter must have gated this differently.

function baseState(overrides: Partial<TurnState> = {}): TurnState {
  return {
    assistantText: "",
    toolCallsThisIteration: [],
    toolsCalledThisTurn: new Set(),
    hasReasoning: false,
    completionTokens: 0,
    iteration: 5,
    evidenceCount: 3,
    evidenceHistory: [3, 3, 3], // flat — would normally fire
    userMessageHasImages: false,
    // The two commit verdicts the caller computes and plumbs in (state.ts).
    // Both default to "nothing on record" — the value that lets the detector
    // fire, which is what this suite's baseline needs. Stated explicitly rather
    // than omitted: they are required fields precisely because `undefined` and
    // `false` are both falsy, so an omission is indistinguishable from a
    // deliberate "no commit" and would arm a nudge silently.
    committedSubstantiveWork: false,
    committedWorkOrLedger: false,
    ...overrides,
  };
}

describe("detectEvidenceStale — tool-call guard", () => {
  it("fires when no tool calls and evidence is flat with no commit", () => {
    const result = detectEvidenceStale(baseState());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("evidence-stale");
  });

  it("does NOT fire when the agent JUST called a tool this iteration", () => {
    // The fix. A tool call's result hasn't been folded into evidence yet,
    // so flat history is premature. Plus, firing here orphans the tool_call.
    const result = detectEvidenceStale(
      baseState({ toolCallsThisIteration: [{ name: "browser", arguments: "{}" }] }),
    );
    expect(result).toBeNull();
  });

  it("does NOT fire on multiple pending tool calls in the same iteration", () => {
    const result = detectEvidenceStale(
      baseState({
        toolCallsThisIteration: [
          { name: "read", arguments: "{}" },
          { name: "grep", arguments: "{}" },
          { name: "browser", arguments: "{}" },
        ],
      }),
    );
    expect(result).toBeNull();
  });

  it("does NOT fire when a committing tool was already called this turn", () => {
    // Pre-existing guard. Pinned so the new tool-call guard doesn't shadow it.
    //
    // The guard used to be re-derived INSIDE the detector by scanning
    // toolsCalledThisTurn with isCommittingTool, so `new Set(["write"])` alone
    // was what stood it down. The verdict is now computed once by the caller
    // and plumbed in, and toolsCalledThisTurn is inert to this detector — so
    // the fixture has to state the verdict itself. `write` is kept in the set
    // to keep the scenario readable, but `committedWorkOrLedger` is what the
    // detector reads; without it this test would run with an empty commit
    // signal and pin nothing at all.
    const result = detectEvidenceStale(
      baseState({ toolsCalledThisTurn: new Set(["write"]), committedWorkOrLedger: true }),
    );
    expect(result).toBeNull();
  });

  it("does NOT fire when evidence history is shorter than 3 iterations", () => {
    // Pre-existing guard. Pinned for the same reason.
    const result = detectEvidenceStale(baseState({ evidenceHistory: [3, 3] }));
    expect(result).toBeNull();
  });

  it("does NOT fire when evidence is changing (not flat)", () => {
    const result = detectEvidenceStale(baseState({ evidenceHistory: [3, 4, 5] }));
    expect(result).toBeNull();
  });

  it("fires after the tool call resolves (next iteration with empty toolCallsThisIteration)", () => {
    // Sanity check: once the tool result lands and the agent emits no new
    // calls (it's stuck thinking), the detector SHOULD fire.
    const result = detectEvidenceStale(
      baseState({
        toolCallsThisIteration: [],
        toolsCalledThisTurn: new Set(["browser", "browser", "browser"]),
        evidenceHistory: [3, 3, 3],
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("evidence-stale");
  });
});
