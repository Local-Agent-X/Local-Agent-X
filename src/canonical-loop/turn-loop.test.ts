import { describe, it, expect, vi, beforeEach } from "vitest";

// driveTurn orchestrates a large collaborator graph (adapter, middlewares,
// tool dispatch, commit, verify gates). Mock every stateful/external one so the
// test exercises just the two control-flow invariants under test:
//   CL-2 — a Stop that lands DURING decideTurnOutcome's verify gates must bail
//          BEFORE commitTurn (else cancelling→succeeded throws → op wedged).
//   CL-8 — a THROWN adapter error on the retry path must retract the partial
//          the user already saw (replace:true), so user-view == committed view.
vi.mock("./event-emitter.js", () => ({
  emit: vi.fn(),
  emitErrorOnce: vi.fn(),
  publishStreamChunk: vi.fn(),
}));
vi.mock("./state-machine.js", () => ({ transitionOp: vi.fn() }));
vi.mock("./checkpoint.js", () => ({ commitTurn: vi.fn() }));
vi.mock("./runtime.js", () => ({ getToolsForOp: vi.fn(() => []) }));
vi.mock("./middlewares/host.js", () => ({
  buildCanonicalLoopContext: vi.fn(() => ({ toolCalls: [] })),
  getActiveMiddlewareStack: vi.fn(() => []),
  runMiddlewarePhase: vi.fn(async () => ({ kind: "continue" })),
}));
vi.mock("./middlewares/evidence-history.js", () => ({ getEvidenceHistory: vi.fn(() => []) }));
vi.mock("./turn-loop/content-extract.js", () => ({
  extractText: vi.fn(() => ""),
  extractToolResultText: vi.fn(() => ""),
}));
vi.mock("./turn-loop/nudges.js", () => ({
  appendNudgeAsUserMessage: vi.fn(),
  middlewareAbortResult: vi.fn(() => ({ terminalReason: "error", toolCount: 0, messageCount: 0, cancelled: false })),
}));
vi.mock("./turn-loop/build-input.js", () => ({
  buildTurnInput: vi.fn(async () => ({})),
  readPendingRedirect: vi.fn(() => null),
}));
vi.mock("./turn-loop/inject-drain.js", () => ({ drainInjectsIntoTurn: vi.fn() }));
vi.mock("../agent-loop/inject-queue.js", () => ({ opConsumesInjects: vi.fn(() => false) }));
vi.mock("./turn-loop/dispatch-tools.js", () => ({
  dispatchTools: vi.fn(async () => ({ toolMessages: [], toolSummary: [] })),
}));
vi.mock("./turn-loop/idle-watchdog.js", () => ({
  createIdleWatchdog: vi.fn(() => ({ noteActivity: vi.fn(), disarm: vi.fn() })),
  readIdleTimeoutMs: vi.fn(() => 600000),
}));
vi.mock("./turn-loop/snapshot-apps.js", () => ({ snapshotTouchedApps: vi.fn() }));
vi.mock("./turn-loop/decide-outcome.js", () => ({
  decideTurnOutcome: vi.fn(async () => ({ terminalReason: "done", allMessages: [] })),
}));

import { driveTurn } from "./turn-loop.js";
import { publishStreamChunk } from "./event-emitter.js";
import { commitTurn } from "./checkpoint.js";
import { buildTurnInput } from "./turn-loop/build-input.js";
import type { Adapter } from "./adapter-contract.js";
import type { Op } from "../ops/types.js";

let opSeq = 0;
const freshOp = (): Op => ({ id: `op-turnloop-${opSeq++}`, type: "chat_turn" }) as unknown as Op;

function okAdapter(): Adapter {
  return {
    runTurn: vi.fn(async () => ({ providerState: { v: 1 }, terminalReason: "done", modelStop: "ended" })),
    abort: vi.fn(),
  } as unknown as Adapter;
}

describe("driveTurn — cancel that lands during verify gates (CL-2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bails without committing when isCancelled flips AFTER decideTurnOutcome", async () => {
    // false at the pre-dispatch check, false at the post-dispatch check, then
    // true — modelling a Stop that arrives while the (slow) build/render verify
    // gates run inside decideTurnOutcome. commitTurn must NOT fire, or it would
    // attempt the illegal cancelling→succeeded transition and wedge the op.
    let calls = 0;
    const isCancelled = vi.fn(() => ++calls >= 3);
    const res = await driveTurn(freshOp(), okAdapter(), 0, { isCancelled });
    expect(commitTurn).not.toHaveBeenCalled();
    expect(res.cancelled).toBe(true);
    expect(res.terminalReason).toBeNull();
  });

  it("commits normally when no cancel arrives (the fix does not over-bail)", async () => {
    const res = await driveTurn(freshOp(), okAdapter(), 0, { isCancelled: () => false });
    expect(commitTurn).toHaveBeenCalledTimes(1);
    expect(res.cancelled).toBe(false);
  });
});

describe("driveTurn — thrown adapter error retries (CL-8)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retracts the partial the user already saw before nudging a resume", async () => {
    const throwingAdapter = {
      runTurn: vi.fn(async () => { throw new Error("xai call threw: operation aborted due to timeout"); }),
      abort: vi.fn(),
    } as unknown as Adapter;
    const res = await driveTurn(freshOp(), throwingAdapter, 0, {});
    // Retry path (streak within cap): loop continues, nothing committed…
    expect(res.terminalReason).toBeNull();
    expect(res.cancelled).toBe(false);
    expect(commitTurn).not.toHaveBeenCalled();
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
    const reasoningAdapter = {
      runTurn: vi.fn(async (_input: unknown, report: (r: unknown) => void) => {
        report({ kind: "reasoning_chunk", delta: "let me think" });
        report({ kind: "stream_chunk", body: { delta: "the answer" } });
        return { providerState: { v: 1 }, terminalReason: "done", modelStop: "ended" };
      }),
      abort: vi.fn(),
    } as unknown as Adapter;
    await driveTurn(freshOp(), reasoningAdapter, 0, { isCancelled: () => false });
    // Reasoning rides the ephemeral stream bus with a marker the pump keys on,
    // and the answer text stays on its own (unmarked) lane.
    expect(publishStreamChunk).toHaveBeenCalledWith(expect.any(String), { reasoning: true, delta: "let me think" });
    expect(publishStreamChunk).toHaveBeenCalledWith(expect.any(String), { delta: "the answer" });
  });
});

describe("driveTurn — compacted-view marker reaches the committed provider_state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stamps viewCompacted onto the envelope when buildTurnInput compacted the view", async () => {
    vi.mocked(buildTurnInput).mockResolvedValueOnce({ viewCompacted: true } as never);
    await driveTurn(freshOp(), okAdapter(), 0, { isCancelled: () => false });
    expect(commitTurn).toHaveBeenCalledTimes(1);
    const committed = vi.mocked(commitTurn).mock.calls[0][0];
    // Marker present AND the adapter's own payload preserved.
    expect(committed.providerState).toEqual({ v: 1, viewCompacted: true });
  });

  it("stamps an explicit false on uncompacted turns — the era marker", async () => {
    await driveTurn(freshOp(), okAdapter(), 0, { isCancelled: () => false });
    const committed = vi.mocked(commitTurn).mock.calls[0][0];
    // Every committed turn carries the boolean; absence must only ever mean
    // "pre-stamp-era row" to lastTurnUsage's refusal logic.
    expect(committed.providerState).toEqual({ v: 1, viewCompacted: false });
  });
});
