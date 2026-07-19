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
vi.mock("../../tool-tracker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tool-tracker.js")>()),
  classifyOpCategory: vi.fn(() => "coding"),
  recordOpOutcome: vi.fn(),
}));
vi.mock("../../cognition/cross-session-learning/index.js", () => ({
  default: { recordOutcome: vi.fn() },
}));
vi.mock("../../data-lineage/taint.js", () => ({
  getTaintSummary: vi.fn(() => ({ count: 0, sources: [] })),
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
vi.mock("./spec-audit.js", () => ({
  runSpecAuditGate: vi.fn(async () => ({ nudge: "", shouldRetry: false })),
}));
// Capture the P-1 measurement log line without touching real logging. One
// shared stub so a test can read `createLogger().info.mock.calls`.
vi.mock("../../logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { createLogger: () => logger };
});
// Stub the durable P-1 sink so these tests never write ~/.lax/p1-metrics.json.
vi.mock("./p1-metrics.js", () => ({ recordP1Outcome: vi.fn() }));

import { decideTurnOutcome, type DecideOutcomeInput } from "./decide-outcome.js";
import { recordCommittedLearningOutcome, recordTerminalOutcome } from "./record-outcome.js";
import { publishStreamChunk } from "../event-emitter.js";
import { recordOpOutcome } from "../../tool-tracker.js";
import crossSessionLearner from "../../cognition/cross-session-learning/index.js";
import { clearExternalIngestion, recordExternalIngestion } from "../../data-lineage/external.js";
import { getTaintSummary } from "../../data-lineage/taint.js";
import { readOpTurns } from "../store.js";
import type { ToolCall } from "../contract-types.js";
import type { CommitTurnMessage } from "../checkpoint.js";
import type { ToolCallSummary } from "../types.js";
import type { Op } from "../../ops/types.js";

const op = { id: "op-test", type: "chat_turn", ownerId: "local-user" } as unknown as Op;

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
    // Default: no explicit continue signal (modelStop undefined path). Tests
    // that exercise the honor-tool_use fix set this true explicitly.
    modelWantsToContinue: false,
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

describe("decideTurnOutcome — P-1 mutation-wrapup measurement (behavior-neutral)", () => {
  beforeEach(() => vi.clearAllMocks());

  // A successful, non-silent MUTATION (write) committed this turn, WITH narration
  // and NEITHER stop signal (modelSignaledDone=false, modelWantsToContinue=false
  // via the input() default) — the modelStop-undefined FALLBACK path. Here the
  // mutation still terminates (the original "avoid a redundant wrap-up" behavior
  // for adapters that surface no stop reason). The honored-continue case is
  // exercised in the "P-1 FIX" block below.
  const writeCall: ToolCall = { toolCallId: "w1", tool: "write", args: { path: "/x", content: "y" } };
  const writeOk: CommitTurnMessage = {
    messageId: "trw1", role: "tool", content: { toolCallId: "w1", text: "[ok]\nwrote 3 lines" },
  } as unknown as CommitTurnMessage;
  const writeSummary = [{ tool: "write", toolCallId: "w1" }] as unknown as ToolCallSummary[];

  const mutationInput = (over: Partial<DecideOutcomeInput> = {}) =>
    input({
      toolCalls: [writeCall],
      toolMessages: [writeOk],
      toolSummary: writeSummary,
      assistantText: "Writing the file, then I'll run the tests.",
      modelSignaledDone: false,
      ...over,
    });

  const p1Lines = async () => {
    const { createLogger } = await import("../../logger.js");
    const logger = (createLogger as unknown as () => { info: ReturnType<typeof vi.fn> })();
    return logger.info.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("[p1-mutation-wrapup]"));
  };

  const recordMock = async () => {
    const { recordP1Outcome } = await import("./p1-metrics.js");
    return recordP1Outcome as unknown as ReturnType<typeof vi.fn>;
  };

  it("logs + durably records outcome=terminated when the shortcut is the sole decider AND stands", async () => {
    const r = await decideTurnOutcome(mutationInput());
    expect(r.terminalReason).toBe("done"); // the clause fired (no gate re-opened)
    const lines = await p1Lines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("outcome=terminated");
    expect(lines[0]).toContain("op=op-test");
    // The fixture narration promises a follow-up ("then I'll run the tests") —
    // the harm subset. Recorded as promisedFollowup=true.
    expect(lines[0]).toContain("promisedFollowup=true");
    expect(await recordMock()).toHaveBeenCalledWith("terminated", true);
  });

  it("records terminated with promisedFollowup=false when the narration promises nothing further", async () => {
    const r = await decideTurnOutcome(mutationInput({ assistantText: "Wrote the file. Done." }));
    expect(r.terminalReason).toBe("done");
    const lines = await p1Lines();
    expect(lines[0]).toContain("outcome=terminated");
    expect(lines[0]).toContain("promisedFollowup=false");
    expect(await recordMock()).toHaveBeenCalledWith("terminated", false);
  });

  it("does NOT log or record when the model really signaled done (clause redundant, not decider)", async () => {
    const r = await decideTurnOutcome(mutationInput({ modelSignaledDone: true }));
    expect(r.terminalReason).toBe("done");
    expect(await p1Lines()).toEqual([]); // modelSignaledDone already terminates
    expect(await recordMock()).not.toHaveBeenCalled();
  });

  it("logs + records outcome=reopened-by-gate when a completion gate re-opens the terminated turn", async () => {
    // Same sole-decider shape, but build-verify re-opens the turn — so no
    // follow-up was actually dropped, and the measurement must say so.
    const { opEditedSourceUnverified } = await import("../middlewares/verify-gate.js");
    (opEditedSourceUnverified as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    const { runBuildVerifyGate } = await import("./build-verify.js");
    (runBuildVerifyGate as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      nudge: "STOP — build red", shouldRetry: true, capReached: false,
    });
    const r = await decideTurnOutcome(mutationInput());
    expect(r.terminalReason).toBeNull();
    const lines = await p1Lines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("outcome=reopened-by-gate");
    // A gate re-opened the turn, so nothing was lost — promisedFollowup is
    // irrelevant here and recorded as false regardless of narration.
    expect(await recordMock()).toHaveBeenCalledWith("reopened-by-gate", false);
  });
});

describe("decideTurnOutcome — P-1 FIX: honor the model's continue signal", () => {
  beforeEach(() => vi.clearAllMocks());

  // The real multi-step-build shape: the model committed a file write AND its
  // finish_reason was tool_calls / tool_use (modelWantsToContinue) — it is
  // asking for another turn. Before the fix, the mutationCommitted shortcut
  // terminated the op anyway, ending the build after every file write and
  // forcing a nudge each step (observed on BOTH grok and Anthropic). Now the
  // continue signal must win: the op keeps going with no user nudge.
  const writeCall: ToolCall = { toolCallId: "w1", tool: "write", args: { path: "/x", content: "y" } };
  const writeOk: CommitTurnMessage = {
    messageId: "trw1", role: "tool", content: { toolCallId: "w1", text: "[ok]\nwrote 3 lines" },
  } as unknown as CommitTurnMessage;
  const writeSummary = [{ tool: "write", toolCallId: "w1" }] as unknown as ToolCallSummary[];
  const continuingWrite = (over: Partial<DecideOutcomeInput> = {}) =>
    input({
      toolCalls: [writeCall],
      toolMessages: [writeOk],
      toolSummary: writeSummary,
      assistantText: "Wrote index.html. Now the stylesheet.",
      modelSignaledDone: false,
      modelWantsToContinue: true,
      ...over,
    });

  const p1Lines = async () => {
    const { createLogger } = await import("../../logger.js");
    const logger = (createLogger as unknown as () => { info: ReturnType<typeof vi.fn> })();
    return logger.info.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("[p1-mutation-wrapup]"));
  };

  it("a committed mutation does NOT terminate when the model signaled continue (drives another turn)", async () => {
    const r = await decideTurnOutcome(continuingWrite());
    expect(r.terminalReason).toBeNull(); // honored tool_use → keep going, no nudge
  });

  it("records NO P-1 fire when the continue signal is honored (nothing was cut off)", async () => {
    await decideTurnOutcome(continuingWrite());
    expect(await p1Lines()).toEqual([]);
    const { recordP1Outcome } = await import("./p1-metrics.js");
    expect(recordP1Outcome as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("STILL terminates on a committed mutation when there is NO continue signal (fallback intact)", async () => {
    // modelStop-undefined path: no continue signal and the model didn't end —
    // the original mutation fallback must still terminate so no-signal adapters
    // don't hang waiting for a stop that never comes.
    const r = await decideTurnOutcome(continuingWrite({ modelWantsToContinue: false }));
    expect(r.terminalReason).toBe("done");
  });
});

describe("decideTurnOutcome — silent browser actions honor explicit continuation", () => {
  beforeEach(() => vi.clearAllMocks());

  const scrollCall: ToolCall = {
    toolCallId: "browser-scroll-1",
    tool: "browser",
    args: { action: "scroll", direction: "down" },
  };
  const scrollOk: CommitTurnMessage = {
    messageId: "tr-browser-scroll-1",
    role: "tool",
    content: { toolCallId: "browser-scroll-1", text: "[ok]\nscrolled" },
  } as unknown as CommitTurnMessage;
  const scrollSummary = [{ tool: "browser", toolCallId: "browser-scroll-1" }] as unknown as ToolCallSummary[];
  const browserScroll = (over: Partial<DecideOutcomeInput> = {}) =>
    input({
      toolCalls: [scrollCall],
      toolMessages: [scrollOk],
      toolSummary: scrollSummary,
      assistantText: "I opened the three sites. I'll scroll this page and continue comparing them.",
      modelSignaledDone: false,
      modelWantsToContinue: true,
      ...over,
    });

  it("keeps running after a narrated scroll when the model paused for the tool result", async () => {
    const r = await decideTurnOutcome(browserScroll());
    expect(r.terminalReason).toBeNull();
  });

  it("preserves the silent-tool shortcut when the adapter supplied no continue signal", async () => {
    const r = await decideTurnOutcome(browserScroll({ modelWantsToContinue: false }));
    expect(r.terminalReason).toBe("done");
  });

  it("still trusts an explicit end signal for a narrated silent browser action", async () => {
    const r = await decideTurnOutcome(browserScroll({
      modelSignaledDone: true,
      modelWantsToContinue: false,
    }));
    expect(r.terminalReason).toBe("done");
  });

  it("keeps voice_visual fire-and-forget even when the provider says continue", async () => {
    const visualCall: ToolCall = {
      toolCallId: "voice-visual-1",
      tool: "voice_visual",
      args: { kind: "mood", value: "happy" },
    };
    const r = await decideTurnOutcome(input({
      toolCalls: [visualCall],
      toolMessages: [{
        messageId: "tr-voice-visual-1",
        role: "tool",
        content: { toolCallId: "voice-visual-1", text: "[ok]" },
      } as unknown as CommitTurnMessage],
      toolSummary: [{ tool: "voice_visual", toolCallId: "voice-visual-1" }] as unknown as ToolCallSummary[],
      assistantText: "That sounds wonderful.",
      modelSignaledDone: false,
      modelWantsToContinue: true,
    }));
    expect(r.terminalReason).toBe("done");
  });

  it("keeps running when a mixed silent batch includes a browser action", async () => {
    const visualCall: ToolCall = {
      toolCallId: "voice-visual-mixed-1",
      tool: "voice_visual",
      args: { kind: "mood", value: "focused" },
    };
    const r = await decideTurnOutcome(browserScroll({
      toolCalls: [scrollCall, visualCall],
      toolMessages: [
        scrollOk,
        {
          messageId: "tr-voice-visual-mixed-1",
          role: "tool",
          content: { toolCallId: "voice-visual-mixed-1", text: "[ok]" },
        } as unknown as CommitTurnMessage,
      ],
      toolSummary: [
        { tool: "browser", toolCallId: "browser-scroll-1" },
        { tool: "voice_visual", toolCallId: "voice-visual-mixed-1" },
      ] as unknown as ToolCallSummary[],
    }));
    expect(r.terminalReason).toBeNull();
  });

  it("keeps memory writes fire-and-forget even when the provider says continue", async () => {
    const memoryCall: ToolCall = {
      toolCallId: "memory-save-1",
      tool: "memory_save",
      args: { fact: "The user prefers concise answers." },
    };
    const r = await decideTurnOutcome(input({
      toolCalls: [memoryCall],
      toolMessages: [{
        messageId: "tr-memory-save-1",
        role: "tool",
        content: { toolCallId: "memory-save-1", text: "[ok]\nsaved" },
      } as unknown as CommitTurnMessage],
      toolSummary: [{ tool: "memory_save", toolCallId: "memory-save-1" }] as unknown as ToolCallSummary[],
      assistantText: "I'll remember that.",
      modelSignaledDone: false,
      modelWantsToContinue: true,
    }));
    expect(r.terminalReason).toBe("done");
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
  beforeEach(() => {
    vi.clearAllMocks();
    clearExternalIngestion("external-session");
    clearExternalIngestion("external-terminal-session");
    vi.mocked(getTaintSummary).mockReturnValue({ count: 0, sources: [] });
  });

  it("records a clean outcome on a terminal done with no open steps", async () => {
    const { recordOpOutcome } = await import("../../tool-tracker.js");
    const result = await decideTurnOutcome(input({ toolCalls: [], toolMessages: [], toolSummary: [] }));
    expect(recordOpOutcome).toHaveBeenCalledWith("coding", "clean", "grok-4.3");
    expect(result.terminalOutcome).toBe("clean");
    expect(crossSessionLearner.recordOutcome).not.toHaveBeenCalled();
  });

  it("does not persist learning evidence before the terminal commit", () => {
    (readOpTurns as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([{
      toolCallSummary: [{ tool: "read" }, { tool: "edit" }, { tool: "edit" }],
      observedTools: ["WebSearch"],
    }]);

    recordTerminalOutcome(op, "clean", ["bash", "bash"]);

    expect(crossSessionLearner.recordOutcome).not.toHaveBeenCalled();
  });

  it("preserves repeated tool order when committed evidence is recorded", () => {
    (readOpTurns as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([{
      toolCallSummary: [{ tool: "read" }, { tool: "edit" }, { tool: "edit" }],
      observedTools: ["bash", "bash"],
    }]);

    recordCommittedLearningOutcome(op, "clean", "session-stable");

    expect(crossSessionLearner.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      // A missing live session binding must fall back to the distinct op id,
      // never the shared local-user owner principal.
      sessionId: "session-stable",
      tools: ["read", "edit", "edit", "bash", "bash"],
    }));
  });

  it("excludes native external tools observed inside the provider subprocess", () => {
    (readOpTurns as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([{
      toolCallSummary: [{ tool: "read" }],
      observedTools: ["WebSearch"],
    }]);

    recordCommittedLearningOutcome(op, "clean", "native-search-session");

    expect(crossSessionLearner.recordOutcome).not.toHaveBeenCalled();
  });

  it("keeps local LAX MCP aliases eligible after canonical normalization", () => {
    (readOpTurns as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([{
      toolCallSummary: [],
      observedTools: ["mcp__lax__read", "mcp__lax__write", "mcp__lax__bash"],
    }]);

    recordCommittedLearningOutcome(op, "clean", "local-mcp-session");

    expect(crossSessionLearner.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      tools: ["mcp__lax__read", "mcp__lax__write", "mcp__lax__bash"],
    }));
  });

  it.each(["mcp__lax__web_search", "mcp__lax__browser"])(
    "excludes external LAX MCP alias %s after canonical normalization",
    (tool) => {
      (readOpTurns as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([{
        toolCallSummary: [], observedTools: [tool],
      }]);

      recordCommittedLearningOutcome(op, "clean", `external-${tool}`);

      expect(crossSessionLearner.recordOutcome).not.toHaveBeenCalled();
    },
  );

  it("keeps true dynamic MCP server tools external after normalization", () => {
    (readOpTurns as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([{
      toolCallSummary: [], observedTools: ["mcp__github__search_issues"],
    }]);

    recordCommittedLearningOutcome(op, "clean", "dynamic-mcp-session");

    expect(crossSessionLearner.recordOutcome).not.toHaveBeenCalled();
  });

  it("excludes outcomes without conversation provenance", () => {
    recordCommittedLearningOutcome(op, "clean", "");

    expect(crossSessionLearner.recordOutcome).not.toHaveBeenCalled();
  });

  it("excludes externally influenced sessions from committed learning evidence", () => {
    recordExternalIngestion("external-session");

    recordCommittedLearningOutcome(op, "clean", "external-session");

    expect(crossSessionLearner.recordOutcome).not.toHaveBeenCalled();
  });

  it("excludes sensitive-tainted sessions from committed learning evidence", () => {
    vi.mocked(getTaintSummary).mockReturnValueOnce({ count: 1, sources: ["sensitive_file"] });

    recordCommittedLearningOutcome(op, "clean", "sensitive-session");

    expect(crossSessionLearner.recordOutcome).not.toHaveBeenCalled();
  });

  it("keeps terminal outcome classification autonomous for an externally influenced session", async () => {
    recordExternalIngestion("external-terminal-session");

    const result = await decideTurnOutcome(input({ toolCalls: [], toolMessages: [], toolSummary: [] }));

    expect(result).toMatchObject({ terminalReason: "done", terminalOutcome: "clean" });
    expect(recordOpOutcome).toHaveBeenCalledWith("coding", "clean", "grok-4.3");
    expect(crossSessionLearner.recordOutcome).not.toHaveBeenCalled();
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

  it("replaces ungrounded codebase advice with a visible checking-status while the nudge continues", async () => {
    const r = await decideTurnOutcome(input({
      toolCalls: [], toolMessages: [], toolSummary: [],
      middlewareDirective: {
        kind: "nudge",
        reason: "codebase-advice-grounding",
        firedBy: "codebase-advice",
        message: "read the repo first",
      },
      finalized: [{ messageId: "am1", role: "assistant", content: { text: "We should add a verifier middleware next." } }],
    }));
    expect(publishStreamChunk).toHaveBeenCalledWith(
      op.id,
      { replace: true, text: "Checking the current repo before I recommend a harness change..." },
    );
    expect(r.allMessages).toEqual([
      {
        messageId: "am1",
        role: "assistant",
        content: { text: "Checking the current repo before I recommend a harness change..." },
      },
    ]);
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

describe("completion-gate table — single ordering source", () => {
  // The gate chain in decideTurnOutcome is now one explicit ordered table
  // (COMPLETION_GATES). This pins its documented sequence so a reorder or an
  // inserted/dropped gate is a loud test failure, not a silent termination
  // change. The order is load-bearing: build must clear before the spec probe,
  // and the late-inject re-check must run AFTER the awaiting gates (CL-5).
  it("evaluates the gates in the exact documented order", async () => {
    const { COMPLETION_GATE_ORDER, COMPLETION_GATES } = await import("./decide-outcome-gates.js");
    expect(COMPLETION_GATE_ORDER).toEqual([
      "render-verify",
      "build-verify",
      "spec-probe",
      "spec-audit",
      "design-verify",
      "earned-done",
      "late-inject",
      // Registers a framework app_build's dev server on the real terminal —
      // must stay LAST so it fires only when no earlier gate re-opened.
      "framework-serve",
    ]);
    // The name list is derived from the table itself — they can never drift.
    expect(COMPLETION_GATES.map((g) => g.name)).toEqual([...COMPLETION_GATE_ORDER]);
  });
});
