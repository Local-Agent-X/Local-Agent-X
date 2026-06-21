import { describe, it, expect, vi, beforeEach } from "vitest";

// decideTurnOutcome drives real side-effecting collaborators (render-verify,
// open-steps, session-bridge, the event bus). Mock the stateful/external ones
// so the test exercises the pure termination DECISION in isolation. The
// done-decision helpers we actually want to test — isSilentToolCall,
// collectToolFailures, isMutationTool — are left real.
vi.mock("../event-emitter.js", () => ({ publishStreamChunk: vi.fn() }));
vi.mock("../../agent-loop/inject-queue.js", () => ({
  hasInjects: vi.fn(() => false),
  opConsumesInjects: vi.fn(() => false),
}));
vi.mock("../../ops/session-bridge.js", () => ({ getSessionForOp: vi.fn(() => undefined) }));
vi.mock("./render-verify.js", () => ({
  runRenderVerifyGate: vi.fn(async () => ({ shouldRetry: false })),
  turnTouchedAppFiles: vi.fn(() => false),
}));
vi.mock("../middlewares/open-steps.js", () => ({
  earnedDoneNudge: vi.fn(() => null),
  openStepsTerminationWarning: vi.fn(() => null),
}));
vi.mock("./nudges.js", () => ({ appendNudgeAsUserMessage: vi.fn() }));

import { decideTurnOutcome, type DecideOutcomeInput } from "./decide-outcome.js";
import type { ToolCall } from "../contract-types.js";
import type { CommitTurnMessage } from "../checkpoint.js";
import type { ToolCallSummary } from "../types.js";
import type { Op } from "../../ops/types.js";

const op = { id: "op-test", type: "chat_turn" } as unknown as Op;

// A successful (non-mutating, non-silent) bash READ: data-returning, so the
// shape heuristic treats it as needing a wrap-up. This is the exact turn shape
// that produced spurious extra turns before the stop signal was plumbed.
const bashCall: ToolCall = { toolCallId: "tc1", tool: "bash", args: { command: "git status" } };
const bashOkResult: CommitTurnMessage = {
  messageId: "tr1",
  role: "tool",
  content: { toolCallId: "tc1", text: "[ok]\nnothing to commit, working tree clean\n" },
} as unknown as CommitTurnMessage;
const bashSummary = [{ tool: "bash", toolCallId: "tc1" }] as unknown as ToolCallSummary[];

function input(over: Partial<DecideOutcomeInput> = {}): DecideOutcomeInput {
  return {
    op,
    turnIdx: 0,
    middlewareDirective: null,
    finalized: [{ messageId: "am1", role: "assistant", content: { text: "Working tree is clean." } }],
    toolMessages: [bashOkResult],
    toolSummary: bashSummary,
    toolCalls: [bashCall],
    assistantText: "Working tree is clean.",
    // Tool turn: the adapter returns terminalReason=undefined → null here, so
    // the loop's done-decision is what's under test.
    adapterTerminalReason: null,
    modelSignaledDone: false,
    adapterError: null,
    ...over,
  };
}

describe("decideTurnOutcome — termination is stop-signal driven", () => {
  beforeEach(() => vi.clearAllMocks());

  it("real tool call + model end_turn → terminates in ONE turn (no wrap-up)", async () => {
    // The regression: a turn makes a real, non-silent, non-mutating tool call,
    // produces user-facing text, and the model declared end_turn. It must be
    // done in a single turn — not drive a spurious wrap-up pass.
    const r = await decideTurnOutcome(input({ modelSignaledDone: true }));
    expect(r.terminalReason).toBe("done");
  });

  it("FALLBACK preserved: same turn with NO stop signal still drives a wrap-up", async () => {
    // Proves (a) the stop signal is the differentiator, and (b) we did not
    // change behavior on paths that don't carry it — a non-silent, non-mutating
    // tool turn with no signal continues exactly as before.
    const r = await decideTurnOutcome(input({ modelSignaledDone: false }));
    expect(r.terminalReason).toBeNull();
  });

  it("BACKSTOP: no-tools informational turn still terminates without a signal", async () => {
    const r = await decideTurnOutcome(input({
      toolCalls: [],
      toolMessages: [],
      toolSummary: [],
      modelSignaledDone: false,
    }));
    expect(r.terminalReason).toBe("done");
  });

  it("BACKSTOP: all-silent turn (memory write) still terminates without a signal", async () => {
    const rememberCall: ToolCall = { toolCallId: "m1", tool: "remember", args: { fact: "x" } };
    const r = await decideTurnOutcome(input({
      toolCalls: [rememberCall],
      toolMessages: [{ messageId: "tr-m1", role: "tool", content: { toolCallId: "m1", text: "[ok]\nsaved" } } as unknown as CommitTurnMessage],
      toolSummary: [{ tool: "remember", toolCallId: "m1" }] as unknown as ToolCallSummary[],
      modelSignaledDone: false,
    }));
    expect(r.terminalReason).toBe("done");
  });

  it("a model end_turn does NOT override a real adapter error", async () => {
    const r = await decideTurnOutcome(input({
      modelSignaledDone: true,
      adapterTerminalReason: "error",
      adapterError: { code: "boom", message: "provider failed" },
    }));
    expect(r.terminalReason).toBe("error");
  });
});
