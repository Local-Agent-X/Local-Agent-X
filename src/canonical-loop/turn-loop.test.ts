import { describe, it, expect, vi, beforeEach } from "vitest";

// driveTurn orchestrates a large collaborator graph (adapter, middlewares,
// tool dispatch, commit, verify gates). Every collaborator the conductor
// calls directly is injected through its TurnLoopDeps parameter
// (turn-loop/turn-deps.ts) — see makeDeps() below — so the test exercises
// just the control-flow invariants under test:
//   CL-2 — a Stop that lands DURING decideTurnOutcome's verify gates must bail
//          BEFORE commitTurn (else cancelling→succeeded throws → op wedged).
//   CL-8 — a THROWN adapter error on the retry path must retract the partial
//          the user already saw (replace:true), so user-view == committed view.
//
// Two module mocks REMAIN, both forced by adapter-throw-recovery.ts running
// REAL — it is the subject of CL-8, so faking it through deps would assert
// nothing — and reaching these modules through its OWN imports:
//   - ./event-emitter.js — recovery retracts the user-visible partial via its
//     own publishStreamChunk import, so the assertion must observe the module
//     itself. driveTurn's default deps resolve to the same mocked module.
//   - ./turn-loop/nudges.js — recovery appends its resume nudge via its own
//     appendNudgeAsUserMessage import, which writes op_messages to disk.
vi.mock("./event-emitter.js", () => ({
  emit: vi.fn(),
  emitErrorOnce: vi.fn(),
  publishStreamChunk: vi.fn(),
}));
vi.mock("./turn-loop/nudges.js", () => ({
  appendNudgeAsUserMessage: vi.fn(),
  recoverCommittedStrategyPivot: vi.fn(() => false),
  middlewareAbortResult: vi.fn(() => ({ terminalReason: "error", toolCount: 0, messageCount: 0, cancelled: false })),
}));

import { driveTurn, type TurnLoopDeps } from "./turn-loop.js";
import { publishStreamChunk } from "./event-emitter.js";
import { appendNudgeAsUserMessage } from "./turn-loop/nudges.js";
import type { Adapter, TurnInput } from "./adapter-contract.js";
import type { CanonicalLoopContext } from "./middlewares/types.js";
import type { Op } from "../ops/types.js";

let opSeq = 0;
const freshOp = (): Op => ({ id: `op-turnloop-${opSeq++}`, type: "chat_turn" }) as unknown as Op;

function okAdapter(): Adapter {
  return {
    runTurn: vi.fn(async () => ({ providerState: { v: 1 }, terminalReason: "done", modelStop: "ended" })),
    abort: vi.fn(),
  } as unknown as Adapter;
}

/** Injected stand-ins for every collaborator driveTurn calls directly — the
 *  same benign defaults the old vi.mock factories provided, now plain values
 *  scoped to one test. Assertions read the fakes (deps.commitTurn etc.). */
function makeDeps() {
  return {
    commitTurn: vi.fn(),
    recoverCommittedStrategyPivot: vi.fn(() => false),
    runMiddlewarePhase: vi.fn(async () => ({ kind: "continue" as const })),
    extractText: vi.fn(() => ""),
    extractToolResultText: vi.fn(() => ""),
    buildTurnInput: vi.fn(async (op: Op, turnIdx: number): Promise<TurnInput> => ({
      opId: op.id,
      turnIdx,
      messages: [],
      tools: [],
    })),
    readPendingRedirect: vi.fn(() => null),
    drainInjectsIntoTurn: vi.fn(),
    opConsumesInjects: vi.fn(() => false),
    dispatchTools: vi.fn(async () => ({ toolMessages: [], toolSummary: [] })),
    createIdleWatchdog: vi.fn(() => ({ noteActivity: vi.fn(), disarm: vi.fn() })),
    readIdleTimeoutMs: vi.fn(() => 600000),
    snapshotTouchedApps: vi.fn(async () => {}),
    decideTurnOutcome: vi.fn(async () => ({ terminalReason: "done" as const, allMessages: [], terminalOutcome: "clean" as const })),
    resolveLearningSessionId: vi.fn(() => "session-stable"),
    createTurnContextComposer: vi.fn(() => ({
      middlewareStack: [],
      build: () => ({ toolCalls: [] }) as unknown as CanonicalLoopContext,
    })),
  } satisfies TurnLoopDeps;
}

describe("driveTurn — cancel that lands during verify gates (CL-2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bails without committing when isCancelled flips AFTER decideTurnOutcome", async () => {
    // false at the pre-dispatch check, false at the post-dispatch check, then
    // true — modelling a Stop that arrives while the (slow) build/render verify
    // gates run inside decideTurnOutcome. commitTurn must NOT fire, or it would
    // attempt the illegal cancelling→succeeded transition and wedge the op.
    const deps = makeDeps();
    let calls = 0;
    const isCancelled = vi.fn(() => ++calls >= 3);
    const res = await driveTurn(freshOp(), okAdapter(), 0, { isCancelled }, deps);
    expect(deps.commitTurn).not.toHaveBeenCalled();
    expect(res.cancelled).toBe(true);
    expect(res.terminalReason).toBeNull();
  });

  it("commits normally when no cancel arrives (the fix does not over-bail)", async () => {
    const deps = makeDeps();
    const res = await driveTurn(freshOp(), okAdapter(), 0, { isCancelled: () => false }, deps);
    expect(deps.commitTurn).toHaveBeenCalledTimes(1);
    expect(deps.commitTurn).toHaveBeenCalledWith(expect.objectContaining({
      learnedOutcome: "clean",
      learningSessionId: "session-stable",
    }));
    expect(res.cancelled).toBe(false);
  });

  it.each([
    ["partial", "done"],
    ["aborted", "error"],
  ] as const)("passes the normal %s outcome into the terminal commit", async (outcome, terminalReason) => {
    const deps = makeDeps();
    deps.decideTurnOutcome.mockResolvedValueOnce({
      terminalReason,
      allMessages: [],
      terminalOutcome: outcome,
    } as never);
    await driveTurn(freshOp(), okAdapter(), 0, { isCancelled: () => false }, deps);
    expect(deps.commitTurn).toHaveBeenCalledWith(expect.objectContaining({
      learnedOutcome: outcome,
      learningSessionId: "session-stable",
    }));
  });

  it("does not learn a provisional success when commitTurn fails", async () => {
    const deps = makeDeps();
    deps.commitTurn.mockImplementationOnce(() => { throw new Error("disk full"); });

    await expect(
      driveTurn(freshOp(), okAdapter(), 0, { isCancelled: () => false }, deps),
    ).rejects.toThrow("disk full");
  });
});

describe("driveTurn — completed-result pivot durability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists an after-tool pivot for the next turn before returning", async () => {
    const deps = makeDeps();
    const metadata = { strategyPivot: { pattern: "exact-repeat", strategyId: "alternate-route", epoch: 2 } };
    deps.runMiddlewarePhase
      .mockResolvedValueOnce({ kind: "continue" })
      .mockResolvedValueOnce({ kind: "continue" })
      .mockResolvedValueOnce({ kind: "nudge", reason: "strategy-pivot", message: "pivot now", metadata } as never);
    await driveTurn(freshOp(), okAdapter(), 7, { isCancelled: () => false }, deps);
    expect(deps.commitTurn).toHaveBeenCalledTimes(1);
    expect(deps.commitTurn).toHaveBeenCalledWith(expect.objectContaining({
      nextTurnPivot: { message: "pivot now", metadata },
    }));
    expect(deps.recoverCommittedStrategyPivot).toHaveBeenLastCalledWith(expect.any(String), 7);
    expect(deps.commitTurn.mock.invocationCallOrder[0])
      .toBeLessThan(deps.recoverCommittedStrategyPivot.mock.invocationCallOrder[1]);
  });

  it("does not persist the next-turn pivot when the current turn commit fails", async () => {
    const deps = makeDeps();
    deps.runMiddlewarePhase
      .mockResolvedValueOnce({ kind: "continue" })
      .mockResolvedValueOnce({ kind: "continue" })
      .mockResolvedValueOnce({
        kind: "nudge",
        reason: "strategy-pivot",
        message: "pivot after commit",
        metadata: { strategyPivot: { pattern: "no-progress", strategyId: "evidence-synthesis", epoch: 1 } },
      } as never);
    deps.commitTurn.mockImplementationOnce(() => { throw new Error("commit failed"); });
    await expect(driveTurn(freshOp(), okAdapter(), 4, { isCancelled: () => false }, deps))
      .rejects.toThrow("commit failed");
    expect(deps.recoverCommittedStrategyPivot).not.toHaveBeenCalledWith(expect.any(String), 4);
  });

  it("does not invoke the dispatcher for an after-model committing-key pivot", async () => {
    const deps = makeDeps();
    deps.runMiddlewarePhase
      .mockResolvedValueOnce({ kind: "continue" })
      .mockResolvedValueOnce({
        kind: "nudge",
        reason: "strategy-pivot",
        message: "duplicate committing call blocked",
        metadata: { strategyPivot: { pattern: "mutation-repeat", strategyId: "alternate-route", epoch: 1 } },
        skipToolDispatch: true,
      } as never);
    await driveTurn(freshOp(), okAdapter(), 3, { isCancelled: () => false }, deps);
    expect(deps.dispatchTools).not.toHaveBeenCalled();
    expect(deps.commitTurn).toHaveBeenCalledWith(expect.objectContaining({
      nextTurnPivot: expect.objectContaining({ message: "duplicate committing call blocked" }),
    }));
    expect(deps.recoverCommittedStrategyPivot).toHaveBeenLastCalledWith(expect.any(String), 3);
    expect(appendNudgeAsUserMessage).not.toHaveBeenCalled();
  });
});

describe("driveTurn — thrown adapter error retries (CL-8)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retracts the partial the user already saw before nudging a resume", async () => {
    const deps = makeDeps();
    const throwingAdapter = {
      runTurn: vi.fn(async () => { throw new Error("xai call threw: operation aborted due to timeout"); }),
      abort: vi.fn(),
    } as unknown as Adapter;
    const res = await driveTurn(freshOp(), throwingAdapter, 0, {}, deps);
    // Retry path (streak within cap): loop continues, nothing committed…
    expect(res.terminalReason).toBeNull();
    expect(res.cancelled).toBe(false);
    expect(deps.commitTurn).not.toHaveBeenCalled();
    // …and the orphaned partial bubble is cleared so user-view == committed view.
    expect(publishStreamChunk).toHaveBeenCalledWith(
      expect.any(String),
      { replace: true, text: "" },
    );
  });
});

describe("driveTurn — reasoning_chunk reports publish a reasoning-marked stream chunk", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps a reasoning_chunk to publishStreamChunk({reasoning:true, delta}), distinct from text", async () => {
    const deps = makeDeps();
    const reasoningAdapter = {
      runTurn: vi.fn(async (_input: unknown, report: (r: unknown) => void) => {
        report({ kind: "reasoning_chunk", delta: "let me think" });
        report({ kind: "stream_chunk", body: { delta: "the answer" } });
        return { providerState: { v: 1 }, terminalReason: "done", modelStop: "ended" };
      }),
      abort: vi.fn(),
    } as unknown as Adapter;
    await driveTurn(freshOp(), reasoningAdapter, 0, { isCancelled: () => false }, deps);
    // Reasoning rides the ephemeral stream bus with a marker the pump keys on,
    // and the answer text stays on its own (unmarked) lane.
    expect(publishStreamChunk).toHaveBeenCalledWith(expect.any(String), { reasoning: true, delta: "let me think" });
    expect(publishStreamChunk).toHaveBeenCalledWith(expect.any(String), { delta: "the answer" });
  });
});

describe("driveTurn — compacted-view marker reaches the committed provider_state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stamps viewCompacted onto the envelope when buildTurnInput compacted the view", async () => {
    const deps = makeDeps();
    deps.buildTurnInput.mockResolvedValueOnce({ opId: "op-compacted", turnIdx: 0, messages: [], tools: [], viewCompacted: true });
    await driveTurn(freshOp(), okAdapter(), 0, { isCancelled: () => false }, deps);
    expect(deps.commitTurn).toHaveBeenCalledTimes(1);
    const committed = deps.commitTurn.mock.calls[0][0];
    // Marker present AND the adapter's own payload preserved.
    expect(committed.providerState).toEqual({ v: 1, viewCompacted: true });
  });

  it("stamps an explicit false on uncompacted turns — the era marker", async () => {
    const deps = makeDeps();
    await driveTurn(freshOp(), okAdapter(), 0, { isCancelled: () => false }, deps);
    const committed = deps.commitTurn.mock.calls[0][0];
    // Every committed turn carries the boolean; absence must only ever mean
    // "pre-stamp-era row" to lastTurnUsage's refusal logic.
    expect(committed.providerState).toEqual({ v: 1, viewCompacted: false });
  });
});
