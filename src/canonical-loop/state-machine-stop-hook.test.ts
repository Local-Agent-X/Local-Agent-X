import { describe, it, expect, vi, beforeEach } from "vitest";

// Isolate transitionOp's terminal side effects: everything stateful is mocked
// so the test observes exactly one thing — the Stop hook firing contract.
vi.mock("./event-emitter.js", () => ({ emit: vi.fn(), clearEmittedErrorsForOp: vi.fn() }));
vi.mock("./op-persist.js", () => ({ persistOpKeepingSignals: vi.fn() }));
vi.mock("./middlewares/state.js", () => ({ clearMiddlewareStateForOp: vi.fn() }));
vi.mock("./middlewares/evidence-history.js", () => ({ clearEvidenceHistory: vi.fn() }));
vi.mock("./middlewares/open-steps.js", () => ({ clearEarnedDoneStateForOp: vi.fn() }));
vi.mock("./turn-loop/render-verify.js", () => ({ clearRenderVerifyStateForOp: vi.fn() }));
vi.mock("./turn-loop/build-verify.js", () => ({ clearBuildVerifyStateForOp: vi.fn() }));
vi.mock("./turn-loop/design-verify.js", () => ({ clearDesignVerifyStateForOp: vi.fn() }));
vi.mock("./turn-loop/spec-probes.js", () => ({ clearSpecProbeStateForOp: vi.fn() }));
vi.mock("./turn-loop/spec-audit.js", () => ({ clearSpecAuditStateForOp: vi.fn() }));
vi.mock("./instruction-ledger/ledger.js", () => ({ clearOpLedger: vi.fn() }));
vi.mock("../ops/session-bridge.js", () => ({ getSessionForOp: vi.fn(() => "sess-1") }));

const fireDetached = vi.fn();
vi.mock("../hooks/hook-engine.js", () => ({ getHookEngine: () => ({ fireDetached }) }));

import { transitionOp } from "./state-machine.js";
import { getLearnedProtocolEnvelopeForOp, registerLearnedProtocolEnvelopeForOp } from "./runtime.js";
import type { Op } from "../ops/types.js";

const makeOp = (state: string) =>
  ({ id: "op-1", type: "chat_turn", status: "running", canonical: { state } } as unknown as Op);

beforeEach(() => vi.clearAllMocks());

describe("Stop hook event on op terminal", () => {
  it("fires detached with opId/status/session when the op reaches a terminal state", () => {
    registerLearnedProtocolEnvelopeForOp("op-1", {
      slug: "learned-0123456789abcdefabcd", versionId: "version-1",
      candidateId: "learned-0123456789abcdefabcd", allowedTools: ["read"],
    });
    transitionOp(makeOp("running"), "succeeded", "done");
    expect(fireDetached).toHaveBeenCalledWith({
      event: "Stop",
      opId: "op-1",
      opStatus: "succeeded",
      sessionId: "sess-1",
    });
    expect(getLearnedProtocolEnvelopeForOp("op-1")).toBeNull();
  });

  it("fires on failure too, with the failed status", () => {
    registerLearnedProtocolEnvelopeForOp("op-1", {
      slug: "learned-0123456789abcdefabcd", versionId: "version-1",
      candidateId: "learned-0123456789abcdefabcd", allowedTools: ["read"],
    });
    transitionOp(makeOp("running"), "failed", "boom");
    expect(fireDetached).toHaveBeenCalledWith(expect.objectContaining({ event: "Stop", opStatus: "failed" }));
    expect(getLearnedProtocolEnvelopeForOp("op-1")).toBeNull();
  });

  it("does NOT fire on non-terminal transitions", () => {
    transitionOp(makeOp("queued"), "running", "leased");
    expect(fireDetached).not.toHaveBeenCalled();
  });
});
