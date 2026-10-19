import { describe, it, expect } from "vitest";
import { commitTurnInput, type CommittableTurn } from "./commit-input.js";
import type { TurnResult } from "../adapter-contract.js";
import type { Op } from "../../ops/types.js";

function turn(over: Partial<CommittableTurn> = {}): CommittableTurn {
  return {
    op: { id: "op-commit-input" } as unknown as Op,
    turnIdx: 4,
    input: { opId: "op-commit-input", turnIdx: 4, messages: [], tools: [] },
    pendingRedirect: null,
    call: {
      result: { providerState: { providerPayload: { stopReason: "end_turn" } }, trace: { sent: 1 } } as unknown as TurnResult,
      finalized: [], toolCalls: [], observedTools: ["mcp_tool"], sawReasoning: false,
      adapterError: null, assistantText: "", modelMs: 12,
    },
    toolSummary: [],
    toolDispatchMs: 3,
    directive: null,
    outcome: { terminalReason: "done", allMessages: [], terminalOutcome: null },
    learningSessionId: null,
    ...over,
  };
}

describe("commitTurnInput", () => {
  it("stamps viewCompacted as an explicit boolean on every turn", () => {
    expect(commitTurnInput(turn()).providerState).toEqual({ providerPayload: { stopReason: "end_turn" }, viewCompacted: false });
    const compacted = turn({ input: { opId: "o", turnIdx: 4, messages: [], tools: [], viewCompacted: true } });
    expect(commitTurnInput(compacted).providerState.viewCompacted).toBe(true);
  });

  it("carries the model call's timings, trace and observed tools", () => {
    expect(commitTurnInput(turn())).toMatchObject({ modelMs: 12, toolDispatchMs: 3, trace: { sent: 1 }, observedTools: ["mcp_tool"] });
  });

  it("records a consumed redirect only when one was pending", () => {
    expect(commitTurnInput(turn())).toMatchObject({ redirectConsumed: false, redirectInstructionId: undefined, redirectText: undefined });
    const redirected = commitTurnInput(turn({ pendingRedirect: { instructionId: "r1", text: "do X" } as CommittableTurn["pendingRedirect"] }));
    expect(redirected).toMatchObject({ redirectConsumed: true, redirectInstructionId: "r1", redirectText: "do X" });
  });

  it("passes the learning receipt only with a terminal outcome", () => {
    expect(commitTurnInput(turn())).toMatchObject({ learnedOutcome: undefined, learningSessionId: undefined });
    const learned = commitTurnInput(turn({
      outcome: { terminalReason: "done", allMessages: [], terminalOutcome: "success" as never },
      learningSessionId: "s1",
    }));
    expect(learned).toMatchObject({ learnedOutcome: "success", learningSessionId: "s1" });
  });

  it("an abort's note becomes the failure reason, falling back to who aborted", () => {
    const withNote = commitTurnInput(turn({ directive: { kind: "abort", reason: "r", firedBy: "loop-detection", message: "  looping  " } }));
    expect(withNote.failureReason).toBe("looping");
    const blank = commitTurnInput(turn({ directive: { kind: "abort", reason: "r", firedBy: "loop-detection", message: " " } }));
    expect(blank.failureReason).toBe("Turn aborted by loop-detection.");
    expect(commitTurnInput(turn({ directive: { kind: "suspend", reason: "r", firedBy: "x", message: "m" } })).failureReason).toBeUndefined();
  });

  it("a strategy-pivot nudge rides the row as the next-turn pivot; a plain nudge does not", () => {
    const strategyPivot = { pattern: "p" } as never;
    const pivot = commitTurnInput(turn({
      directive: { kind: "nudge", reason: "r", firedBy: "strategy-pivot", message: "try Y", metadata: { strategyPivot } },
    }));
    expect(pivot.nextTurnPivot).toEqual({ message: "try Y", firedBy: "strategy-pivot", metadata: { strategyPivot } });
    const plain = commitTurnInput(turn({ directive: { kind: "nudge", reason: "r", firedBy: "open-steps", message: "go" } }));
    expect(plain.nextTurnPivot).toBeUndefined();
  });
});
