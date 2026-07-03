import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  appIdsTouchedByTurn: vi.fn(() => []),
  registerOpAppTouch: vi.fn(),
}));
vi.mock("../middlewares/open-steps.js", () => ({
  earnedDoneNudge: vi.fn(() => null),
  openStepsTerminationWarning: vi.fn(() => null),
}));
vi.mock("./nudges.js", () => ({ appendNudgeAsUserMessage: vi.fn() }));
vi.mock("../store.js", () => ({ readOpTurns: vi.fn(() => []) }));
vi.mock("../op-model.js", () => ({ resolveOpModel: vi.fn(() => "grok-4.3") }));
vi.mock("../../tool-tracker.js", () => ({
  classifyOpCategory: vi.fn(() => "coding"),
  recordOpOutcome: vi.fn(),
}));
vi.mock("../middlewares/browser-handoff.js", () => ({
  opGaveUpUnrecovered: vi.fn(() => false),
}));
vi.mock("../middlewares/cleanup-verify.js", () => ({
  opCleanupUnverified: vi.fn(() => false),
}));
vi.mock("../middlewares/verify-gate.js", () => ({
  opEditedSourceUnverified: vi.fn(() => false),
  opDeletedTestDodge: vi.fn(() => false),
  opEditedSourcePaths: vi.fn(() => []),
}));
vi.mock("./build-verify.js", () => ({
  runBuildVerifyGate: vi.fn(async () => ({ nudge: "", shouldRetry: false, capReached: false })),
  groundTruthSizesNote: vi.fn(() => null),
}));
vi.mock("./spec-probes.js", () => ({
  runSpecProbeGate: vi.fn(async () => ({ nudge: "", shouldRetry: false })),
}));

import { decideTurnOutcome, type DecideOutcomeInput } from "./decide-outcome.js";
import { recordTerminalOutcome } from "./record-outcome.js";
import { publishStreamChunk } from "../event-emitter.js";
import { recordOpOutcome } from "../../tool-tracker.js";
import { readOpTurns } from "../store.js";
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
    observedTools: [],
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

  it("emits the ground-truth sizes note into the record when it fires on a terminal done", async () => {
    const { groundTruthSizesNote } = await import("./build-verify.js");
    (groundTruthSizesNote as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      "Ground-truth size of the files edited this task … big.ts — 588 lines",
    );
    const r = await decideTurnOutcome(input({ modelSignaledDone: true, assistantText: "Done — big.ts is 294 lines." }));
    expect(r.terminalReason).toBe("done");
    expect(
      r.allMessages.some((m) => (m.content as { text?: string })?.text?.includes("588 lines")),
    ).toBe(true);
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

describe("decideTurnOutcome — live-UI warnings reach the stream (CL-6)", () => {
  beforeEach(() => vi.clearAllMocks());

  // Every subscribeOpStream consumer forwards a chunk only when it carries a
  // non-empty `delta` or `replace:true` — a bare `{text}` is silently dropped.
  // So the loud-partial warning, the build-verify confirmation, and the
  // ground-truth sizes note MUST publish `delta`, or they never appear in the
  // live session (only after a rehydrate) — a partial would look finished.
  const streamCalls = () =>
    (publishStreamChunk as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1] as { delta?: string; text?: string; replace?: boolean },
    );

  it("publishes the loud-partial warning as a forwardable `delta`, not a dropped `{text}`", async () => {
    const { openStepsTerminationWarning } = await import("../middlewares/open-steps.js");
    (openStepsTerminationWarning as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce("⚠️ 1 step still open");
    await decideTurnOutcome(input({ toolCalls: [], toolMessages: [], toolSummary: [] }));
    const warn = streamCalls().find((c) => (c.delta ?? c.text)?.includes("1 step still open"));
    expect(warn).toBeDefined();
    expect(warn!.delta).toContain("1 step still open");
    expect(warn!.text).toBeUndefined();
  });

  it("publishes the ground-truth sizes note as a forwardable `delta`, not a dropped `{text}`", async () => {
    const { groundTruthSizesNote } = await import("./build-verify.js");
    (groundTruthSizesNote as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      "Ground-truth size … big.ts — 588 lines",
    );
    await decideTurnOutcome(input({ modelSignaledDone: true, assistantText: "Done — big.ts is 294 lines." }));
    const note = streamCalls().find((c) => (c.delta ?? c.text)?.includes("588 lines"));
    expect(note).toBeDefined();
    expect(note!.delta).toContain("588 lines");
    expect(note!.text).toBeUndefined();
  });

  it("publishes the build-verify confirmation as a forwardable `delta`, not a dropped `{text}`", async () => {
    const { opEditedSourceUnverified } = await import("../middlewares/verify-gate.js");
    (opEditedSourceUnverified as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    const { runBuildVerifyGate } = await import("./build-verify.js");
    (runBuildVerifyGate as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      nudge: "", shouldRetry: false, capReached: false, verifiedClean: true,
      confirmation: "Verified clean: build + type-check pass.",
    });
    await decideTurnOutcome(input({
      toolCalls: [], toolMessages: [], toolSummary: [], modelSignaledDone: true,
    }));
    const conf = streamCalls().find((c) => (c.delta ?? c.text)?.includes("Verified clean"));
    expect(conf).toBeDefined();
    expect(conf!.delta).toContain("Verified clean");
    expect(conf!.text).toBeUndefined();
  });
});

describe("decideTurnOutcome — late-inject resume-gate (CL-5)", () => {
  beforeEach(() => vi.clearAllMocks());
  // clearAllMocks resets call history but PRESERVES mockReturnValue impls, so
  // the persistent stubs these tests set would leak into later describes. Restore
  // the factory defaults after each test.
  afterEach(async () => {
    const { opConsumesInjects, hasInjects } = await import("../../agent-loop/inject-queue.js");
    const { getSessionForOp } = await import("../../ops/session-bridge.js");
    const { opEditedSourceUnverified } = await import("../middlewares/verify-gate.js");
    const { runBuildVerifyGate } = await import("./build-verify.js");
    (opConsumesInjects as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (hasInjects as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (getSessionForOp as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (opEditedSourceUnverified as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (runBuildVerifyGate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nudge: "", shouldRetry: false, capReached: false,
    });
  });

  it("drains a user inject that arrives DURING the async verify gates instead of stranding it", async () => {
    // The race: the pre-commit inject gate at the top of decideTurnOutcome runs
    // BEFORE the async build/spec verify gates, whose awaits let a WS `inject`
    // land mid-turn. The worker-side resume-gate can't catch it — by the time it
    // runs, commitTurn has already fired the succeeded transition and released
    // the op from its session, so getSessionForOp returns undefined. So the
    // END-of-turn re-check inside decideTurnOutcome (still running + session-
    // bound) is the only place that can keep the turn open to drain it.
    const { opConsumesInjects, hasInjects } = await import("../../agent-loop/inject-queue.js");
    const { getSessionForOp } = await import("../../ops/session-bridge.js");
    const { opEditedSourceUnverified } = await import("../middlewares/verify-gate.js");
    const { runBuildVerifyGate } = await import("./build-verify.js");

    (opConsumesInjects as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getSessionForOp as unknown as ReturnType<typeof vi.fn>).mockReturnValue("sess-1");
    // Queue is EMPTY when the pre-commit inject gate checks it...
    (hasInjects as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    // ...then a user follow-up lands WHILE the async build-verify gate awaits.
    (opEditedSourceUnverified as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (runBuildVerifyGate as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      (hasInjects as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
      return { nudge: "", shouldRetry: false, capReached: false, verifiedClean: false };
    });

    const r = await decideTurnOutcome(input({ modelSignaledDone: true }));
    // Pre-fix: the single pre-commit inject check already passed (queue empty),
    // so terminalReason stayed "done" and the late inject was lost against a
    // terminal op. Post-fix: the end-of-turn re-check sees it and keeps the turn
    // open (null) so the worker loops and drainInjectsIntoTurn pulls it in.
    expect(r.terminalReason).toBeNull();
  });

  it("still terminates when NO inject is pending at the end-of-turn re-check", async () => {
    // Guards against a can't-fail assertion: with the queue empty throughout, a
    // consuming, session-bound op must still terminate normally.
    const { opConsumesInjects, hasInjects } = await import("../../agent-loop/inject-queue.js");
    const { getSessionForOp } = await import("../../ops/session-bridge.js");
    (opConsumesInjects as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getSessionForOp as unknown as ReturnType<typeof vi.fn>).mockReturnValue("sess-1");
    (hasInjects as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const r = await decideTurnOutcome(input({ modelSignaledDone: true }));
    expect(r.terminalReason).toBe("done");
  });
});

describe("decideTurnOutcome — op-outcome telemetry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records a clean outcome on a terminal done with no open steps", async () => {
    const { recordOpOutcome } = await import("../../tool-tracker.js");
    await decideTurnOutcome(input({ toolCalls: [], toolMessages: [], toolSummary: [] }));
    expect(recordOpOutcome).toHaveBeenCalledWith("coding", "clean", "grok-4.3");
  });

  it("records partial when terminal done but open steps remain", async () => {
    const { openStepsTerminationWarning } = await import("../middlewares/open-steps.js");
    (openStepsTerminationWarning as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce("⚠️ 1 step still open");
    const { recordOpOutcome } = await import("../../tool-tracker.js");
    await decideTurnOutcome(input({ toolCalls: [], toolMessages: [], toolSummary: [] }));
    expect(recordOpOutcome).toHaveBeenCalledWith("coding", "partial", "grok-4.3");
  });

  it("records partial when the op ended still giving up (browser-handoff verdict)", async () => {
    const { opGaveUpUnrecovered } = await import("../middlewares/browser-handoff.js");
    (opGaveUpUnrecovered as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    const { recordOpOutcome } = await import("../../tool-tracker.js");
    await decideTurnOutcome(input({ toolCalls: [], toolMessages: [], toolSummary: [] }));
    expect(recordOpOutcome).toHaveBeenCalledWith("coding", "partial", "grok-4.3");
  });

  it("records partial when a cleanup ended without a confirming search (cleanup-verify verdict)", async () => {
    const { opCleanupUnverified } = await import("../middlewares/cleanup-verify.js");
    (opCleanupUnverified as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    const { recordOpOutcome } = await import("../../tool-tracker.js");
    await decideTurnOutcome(input({ toolCalls: [], toolMessages: [], toolSummary: [] }));
    expect(recordOpOutcome).toHaveBeenCalledWith("coding", "partial", "grok-4.3");
  });

  it("orchestrator build-verify suppresses 'done' and loops when the build is red", async () => {
    // The model said done after editing source without a clean verify; the
    // orchestrator ran the build, it failed, so the turn must NOT terminate —
    // the real errors are injected and the same model gets another pass.
    const { opEditedSourceUnverified } = await import("../middlewares/verify-gate.js");
    (opEditedSourceUnverified as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    const { runBuildVerifyGate } = await import("./build-verify.js");
    (runBuildVerifyGate as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      nudge: "STOP — build red: TS2339", shouldRetry: true, capReached: false,
    });
    const { appendNudgeAsUserMessage } = await import("./nudges.js");
    const r = await decideTurnOutcome(input({
      toolCalls: [], toolMessages: [], toolSummary: [], modelSignaledDone: true,
    }));
    expect(runBuildVerifyGate).toHaveBeenCalled();
    expect(appendNudgeAsUserMessage).toHaveBeenCalledWith(op.id, 1, "STOP — build red: TS2339");
    expect(r.terminalReason).toBeNull();
  });

  it("orchestrator build-verify lets 'done' stand when the build passes (no loop)", async () => {
    const { opEditedSourceUnverified } = await import("../middlewares/verify-gate.js");
    (opEditedSourceUnverified as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    const { runBuildVerifyGate } = await import("./build-verify.js");
    (runBuildVerifyGate as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      nudge: "", shouldRetry: false, capReached: false,
    });
    const r = await decideTurnOutcome(input({
      toolCalls: [], toolMessages: [], toolSummary: [], modelSignaledDone: true,
    }));
    expect(runBuildVerifyGate).toHaveBeenCalled();
    expect(r.terminalReason).toBe("done");
  });

  it("spec-probe gate suppresses 'done' and loops when a spec-derived check fails", async () => {
    // Build is green, but the implementation-blind probe caught a behavioral bug,
    // so the turn must not terminate — the same model gets one more pass.
    const { opEditedSourcePaths } = await import("../middlewares/verify-gate.js");
    (opEditedSourcePaths as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(["/proj/wordy.py"]);
    const { runSpecProbeGate } = await import("./spec-probes.js");
    (runSpecProbeGate as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      nudge: "STOP — acceptance check failed", shouldRetry: true,
    });
    const { appendNudgeAsUserMessage } = await import("./nudges.js");
    const r = await decideTurnOutcome(input({
      toolCalls: [], toolMessages: [], toolSummary: [], modelSignaledDone: true,
    }));
    expect(runSpecProbeGate).toHaveBeenCalled();
    expect(appendNudgeAsUserMessage).toHaveBeenCalledWith(op.id, 1, "STOP — acceptance check failed");
    expect(r.terminalReason).toBeNull();
  });

  it("spec-probe gate is skipped when the op edited no source (default off)", async () => {
    const { runSpecProbeGate } = await import("./spec-probes.js");
    (runSpecProbeGate as unknown as ReturnType<typeof vi.fn>).mockClear();
    const r = await decideTurnOutcome(input({
      toolCalls: [], toolMessages: [], toolSummary: [], modelSignaledDone: true,
    }));
    expect(runSpecProbeGate).not.toHaveBeenCalled();
    expect(r.terminalReason).toBe("done");
  });

  it("records aborted on a terminal error", async () => {
    const { recordOpOutcome } = await import("../../tool-tracker.js");
    await decideTurnOutcome(input({
      adapterTerminalReason: "error",
      adapterError: { code: "x", message: "y" },
    }));
    expect(recordOpOutcome).toHaveBeenCalledWith("coding", "aborted", "grok-4.3");
  });

  it("retracts the give-up punt when the browser-handoff nudge fires (no doubling)", async () => {
    const r = await decideTurnOutcome(input({
      toolCalls: [], toolMessages: [], toolSummary: [],
      middlewareDirective: { kind: "nudge", reason: "browser-handoff", firedBy: "browser-handoff", message: "keep driving" },
      finalized: [{ messageId: "am1", role: "assistant", content: { text: "I'm blocked by the overlay — you dismiss it." } }],
    }));
    // The superseded punt is stripped from the commit; the nudge keeps the op
    // running so the next turn (recovery or a single honest re-punt) is shown.
    expect(r.allMessages.some(m => m.role === "assistant")).toBe(false);
    expect(r.terminalReason).toBeNull();
  });

  it("does NOT record on a non-terminal wrap-up turn", async () => {
    const { recordOpOutcome } = await import("../../tool-tracker.js");
    await decideTurnOutcome(input({ modelSignaledDone: false }));
    expect(recordOpOutcome).not.toHaveBeenCalled();
  });

  it("folds observed (CLI/MCP) tools into op categorization", async () => {
    const { classifyOpCategory } = await import("../../tool-tracker.js");
    await decideTurnOutcome(input({
      toolCalls: [], toolMessages: [], toolSummary: [],
      observedTools: ["mcp__lax__browser"],
    }));
    const arg = (classifyOpCategory as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Set<string>;
    expect(arg.has("mcp__lax__browser")).toBe(true);
  });

  it("folds a prior turn's observed tools into op categorization", async () => {
    vi.mocked(readOpTurns).mockReturnValueOnce(
      [{ toolCallSummary: [], observedTools: ["mcp__lax__web_search"] }] as unknown as ReturnType<typeof readOpTurns>,
    );
    const { classifyOpCategory } = await import("../../tool-tracker.js");
    await decideTurnOutcome(input({ toolCalls: [], toolMessages: [], toolSummary: [] }));
    const arg = (classifyOpCategory as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Set<string>;
    expect(arg.has("mcp__lax__web_search")).toBe(true);
  });
});

describe("recordTerminalOutcome — the MAX_TURNS / truncation path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the given outcome under the op's tool-derived category", () => {
    (readOpTurns as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);
    recordTerminalOutcome(op, "aborted", ["grep", "edit"]);
    expect(recordOpOutcome).toHaveBeenCalledWith("coding", "aborted", "grok-4.3");
  });

  it("folds the op's committed-turn tools into the category set, not just this turn's", async () => {
    (readOpTurns as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      [{ toolCallSummary: [{ tool: "browser" }], observedTools: [] }] as unknown as ReturnType<typeof readOpTurns>,
    );
    const { classifyOpCategory } = await import("../../tool-tracker.js");
    recordTerminalOutcome(op, "aborted");
    const arg = (classifyOpCategory as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Set<string>;
    expect(arg.has("browser")).toBe(true);
  });
});
