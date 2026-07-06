// Enforced plan mode — session-scoped standing mandate on the instruction
// ledger. The contract under test:
//  1. Fail-open: unknown sessions / mode off forbids nothing.
//  2. While enforced, exactly the plan-mode mutation classes are forbidden —
//     never egress/sensitive-read (planning is research).
//  3. capabilityForbiddenForOp is the union of the op's own ledger and the
//     session's enforced mode — either source alone must suppress.
//  4. setEnforcedPlanMode reports whether state changed (drives the WS echo).
import { describe, it, expect, afterEach } from "vitest";
import {
  setEnforcedPlanMode,
  isEnforcedPlanMode,
  planModeForbidsCapability,
  capabilityForbiddenForOp,
  PLAN_MODE_PROHIBITIONS,
  _resetEnforcedPlanMode,
} from "./plan-mode.js";
import { setOpLedger, _resetOpLedgers } from "./ledger.js";

afterEach(() => {
  _resetEnforcedPlanMode();
  _resetOpLedgers();
});

describe("enforced plan-mode session state", () => {
  it("fail-open: an unknown session forbids nothing", () => {
    expect(isEnforcedPlanMode("s-unknown")).toBe(false);
    expect(planModeForbidsCapability("s-unknown", "workspace-write")).toBe(false);
    expect(planModeForbidsCapability(undefined, "workspace-write")).toBe(false);
  });

  it("while enforced, forbids exactly the plan-mode mutation classes", () => {
    setEnforcedPlanMode("s1", true);
    expect(planModeForbidsCapability("s1", "workspace-write")).toBe(true);
    // Research stays allowed — plan mode must never block reading or browsing.
    expect(planModeForbidsCapability("s1", "egress")).toBe(false);
    expect(planModeForbidsCapability("s1", "sensitive-read")).toBe(false);
    expect(planModeForbidsCapability("s1", "shell")).toBe(false);
    // And it is scoped to ITS session.
    expect(planModeForbidsCapability("s2", "workspace-write")).toBe(false);
  });

  it("turning the mode off (the approval event) restores permissiveness", () => {
    setEnforcedPlanMode("s1", true);
    setEnforcedPlanMode("s1", false);
    expect(isEnforcedPlanMode("s1")).toBe(false);
    expect(planModeForbidsCapability("s1", "workspace-write")).toBe(false);
  });

  it("setEnforcedPlanMode reports whether state actually changed", () => {
    expect(setEnforcedPlanMode("s1", true)).toBe(true);
    expect(setEnforcedPlanMode("s1", true)).toBe(false); // idempotent repeat
    expect(setEnforcedPlanMode("s1", false)).toBe(true);
    expect(setEnforcedPlanMode("s1", false)).toBe(false);
  });

  it("workspace-write is a plan-mode prohibition (pins the mutation-class contract)", () => {
    expect(PLAN_MODE_PROHIBITIONS).toContain("workspace-write");
  });
});

describe("capabilityForbiddenForOp — union of op ledger and enforced plan mode", () => {
  const op = (id: string, sessionId?: string) =>
    ({ id, canonical: sessionId ? { sessionId } : undefined });

  it("false when neither source forbids", () => {
    expect(capabilityForbiddenForOp(op("op-1", "s1"), "workspace-write")).toBe(false);
  });

  it("true from the op's OWN ledger, plan mode off", () => {
    setOpLedger("op-1", { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit"] });
    expect(capabilityForbiddenForOp(op("op-1", "s1"), "workspace-write")).toBe(true);
  });

  it("true from enforced plan mode alone, empty op ledger", () => {
    setEnforcedPlanMode("s1", true);
    expect(capabilityForbiddenForOp(op("op-1", "s1"), "workspace-write")).toBe(true);
    // A class plan mode doesn't cover stays permitted.
    expect(capabilityForbiddenForOp(op("op-1", "s1"), "egress")).toBe(false);
  });

  it("an op with no canonical.sessionId is untouched by plan mode (fail-open)", () => {
    setEnforcedPlanMode("s1", true);
    expect(capabilityForbiddenForOp(op("op-1"), "workspace-write")).toBe(false);
  });

  it("plan mode on a DIFFERENT session does not leak", () => {
    setEnforcedPlanMode("s-other", true);
    expect(capabilityForbiddenForOp(op("op-1", "s1"), "workspace-write")).toBe(false);
  });
});
