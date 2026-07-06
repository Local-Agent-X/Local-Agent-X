/**
 * Instruction-ledger core invariants:
 *
 *  1. FAIL-OPEN: an op with no ledger gets the permissive default from every
 *     accessor — false / [] / undefined. An empty ledger is equally
 *     unconstrained. Nothing here may spuriously block when the user stated
 *     no constraint.
 *  2. set/get/clear roundtrip, with idempotent clear (op-terminal calls it
 *     unconditionally, possibly more than once).
 *  3. opForbidsCapability is true ONLY for the exact prohibited class on the
 *     exact op — sibling classes and unrelated ops stay permissive.
 *  4. Op-terminal wiring: the real transitionOp() drops the ledger on a
 *     terminal transition (the leak guard added beside
 *     clearMiddlewareStateForOp in state-machine.ts).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  setOpLedger,
  getOpLedger,
  clearOpLedger,
  opForbidsCapability,
  opObligations,
  opHasConstraints,
  _resetOpLedgers,
} from "./ledger.js";
import type { InstructionLedger } from "./ledger.js";
import type { Op } from "../../ops/types.js";

// Mock state-machine's side-effect deps (event emission, disk persistence,
// sibling per-op registries) so the wiring test exercises ONLY the real
// transitionOp → clearOpLedger path. The ledger module itself stays real.
vi.mock("../event-emitter.js", () => ({
  emit: vi.fn(),
  clearEmittedErrorsForOp: vi.fn(),
}));
vi.mock("../op-persist.js", () => ({ persistOpKeepingSignals: vi.fn() }));
vi.mock("../middlewares/state.js", () => ({ clearMiddlewareStateForOp: vi.fn() }));
vi.mock("../middlewares/evidence-history.js", () => ({ clearEvidenceHistory: vi.fn() }));
vi.mock("../middlewares/open-steps.js", () => ({ clearEarnedDoneStateForOp: vi.fn() }));
vi.mock("../turn-loop/render-verify.js", () => ({ clearRenderVerifyStateForOp: vi.fn() }));
vi.mock("../turn-loop/build-verify.js", () => ({ clearBuildVerifyStateForOp: vi.fn() }));
vi.mock("../turn-loop/design-verify.js", () => ({ clearDesignVerifyStateForOp: vi.fn() }));
vi.mock("../turn-loop/spec-probes.js", () => ({ clearSpecProbeStateForOp: vi.fn() }));
vi.mock("../turn-loop/spec-audit.js", () => ({ clearSpecAuditStateForOp: vi.fn() }));
vi.mock("../../ops/session-bridge.js", () => ({ getSessionForOp: vi.fn(() => undefined) }));
vi.mock("../../hooks/hook-engine.js", () => ({ getHookEngine: () => ({ fireDetached: vi.fn() }) }));

afterEach(() => _resetOpLedgers());

describe("instruction ledger", () => {
  it("returns permissive defaults for an op with no ledger", () => {
    expect(getOpLedger("op-unknown")).toBeUndefined();
    expect(opForbidsCapability("op-unknown", "egress")).toBe(false);
    expect(opForbidsCapability("op-unknown", "sensitive-read")).toBe(false);
    expect(opForbidsCapability("op-unknown", "workspace-write")).toBe(false);
    expect(opForbidsCapability("op-unknown", "shell")).toBe(false);
    expect(opObligations("op-unknown")).toEqual([]);
    expect(opHasConstraints("op-unknown")).toBe(false);
  });

  it("treats an empty ledger as unconstrained", () => {
    setOpLedger("op-empty", { prohibitions: [], obligations: [], phrases: [] });
    expect(opHasConstraints("op-empty")).toBe(false);
    expect(opForbidsCapability("op-empty", "egress")).toBe(false);
    expect(opObligations("op-empty")).toEqual([]);
  });

  it("roundtrips set → get → clear, with idempotent clear", () => {
    const ledger: InstructionLedger = {
      prohibitions: ["egress"],
      obligations: [{ kind: "commit-when-done" }],
      phrases: ["don't hit the network", "commit when you're done"],
    };
    setOpLedger("op-rt", ledger);
    expect(getOpLedger("op-rt")).toEqual(ledger);
    expect(opHasConstraints("op-rt")).toBe(true);
    expect(opObligations("op-rt")).toEqual([{ kind: "commit-when-done" }]);

    clearOpLedger("op-rt");
    expect(getOpLedger("op-rt")).toBeUndefined();
    expect(opHasConstraints("op-rt")).toBe(false);
    // op-terminal may clear repeatedly — must stay a no-op
    expect(() => clearOpLedger("op-rt")).not.toThrow();
  });

  it("forbids ONLY the prohibited class, only on the op that set it", () => {
    setOpLedger("op-forbid", { prohibitions: ["egress"], obligations: [], phrases: [] });
    expect(opForbidsCapability("op-forbid", "egress")).toBe(true);
    expect(opForbidsCapability("op-forbid", "sensitive-read")).toBe(false);
    expect(opForbidsCapability("op-forbid", "workspace-write")).toBe(false);
    expect(opForbidsCapability("op-forbid", "shell")).toBe(false);
    // a different op stays permissive
    expect(opForbidsCapability("op-other", "egress")).toBe(false);
  });

  it("counts any populated field as a constraint", () => {
    setOpLedger("op-ob", { prohibitions: [], obligations: [{ kind: "commit-when-done" }], phrases: [] });
    expect(opHasConstraints("op-ob")).toBe(true);
    setOpLedger("op-ph", { prohibitions: [], obligations: [], phrases: ["no destructive commands"] });
    expect(opHasConstraints("op-ph")).toBe(true);
  });
});

describe("op-terminal wiring", () => {
  it("transitionOp drops the ledger on a terminal transition", async () => {
    const { transitionOp } = await import("../state-machine.js");
    const op = {
      id: "op-terminal",
      status: "running",
      canonical: { state: "running" },
    } as unknown as Op;

    setOpLedger(op.id, { prohibitions: ["shell"], obligations: [], phrases: ["no shell"] });
    expect(opForbidsCapability(op.id, "shell")).toBe(true);

    transitionOp(op, "succeeded", "test terminal cleanup");
    expect(getOpLedger(op.id)).toBeUndefined();
    expect(opForbidsCapability(op.id, "shell")).toBe(false);
  });

  it("a non-terminal transition keeps the ledger", async () => {
    const { transitionOp } = await import("../state-machine.js");
    const op = {
      id: "op-pausing",
      status: "running",
      canonical: { state: "running" },
    } as unknown as Op;

    setOpLedger(op.id, { prohibitions: ["egress"], obligations: [], phrases: [] });
    transitionOp(op, "paused", "test non-terminal keeps ledger");
    expect(opForbidsCapability(op.id, "egress")).toBe(true);
  });
});
