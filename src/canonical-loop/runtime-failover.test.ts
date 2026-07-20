import { describe, expect, it } from "vitest";
import {
  candidateWithinBudget,
  buildRuntimeFailoverState,
  attemptRuntimeFailover,
  attemptedTargetsForEpoch,
  failoverPolicyAllows,
  normalizeRuntimeFailure,
  runtimeFailoverEnabled,
  targetMeetsRequirements,
} from "./runtime-failover.js";
import type { TargetCapabilitySnapshot } from "../ops/operation-requirements.js";
import { BROADCAST_KEYS, FLIPPABLE_SETTINGS } from "../settings-schema.js";
import { providerStateAcrossRuntimeBoundary } from "./turn-loop/build-input.js";
import { isRuntimeFailoverBoundary } from "../ops/target-identity.js";
import type { ExactDelegatedRuntimeDescriptor, Op } from "../ops/types.js";

const capable: TargetCapabilitySnapshot = {
  tools: "supported",
  toolsRejected: false,
  vision: "supported",
  streaming: "supported",
  jsonMode: "supported",
  localFiles: "supported",
  contextWindowTokens: 200_000,
  locality: "remote",
};

describe("runtime failover failure taxonomy", () => {
  it.each([
    ["http_429", "", "rate_limit"],
    ["transport_exception", "socket hang up", "timeout"],
    ["http_503", "capacity exhausted", "overloaded"],
    ["runtime_reconstruction_unavailable", "", "timeout"],
    ["http_404", "unknown model", "model_not_found"],
    ["http_401", "expired token", "auth"],
    ["http_402", "billing exhausted", "billing"],
  ])("normalizes %s", (code, message, expected) => {
    expect(normalizeRuntimeFailure(code, message)).toBe(expected);
  });

  it.each([
    ["unknown", "something odd"],
    ["approval_required", "approve this"],
    ["security_block", "policy denied"],
    ["verification_failed", "tests failed"],
    ["aborted", "cancelled"],
  ])("fails closed for %s", (code, message) => {
    expect(normalizeRuntimeFailure(code, message)).toBeNull();
  });
});

describe("runtime failover policy boundary", () => {
  const base = {
    lane: "build" as const,
    normalizedFailure: "timeout",
    pinned: false,
    controlPending: false,
    ambiguousSideEffect: false,
  };

  it("allows unattended normalized runtime failures without asking", () => {
    expect(failoverPolicyAllows(base)).toBe(true);
  });

  it("defaults cross-runtime switching off and requires the exact persisted opt-in", () => {
    expect(runtimeFailoverEnabled(undefined)).toBe(false);
    expect(runtimeFailoverEnabled(false)).toBe(false);
    expect(runtimeFailoverEnabled(true)).toBe(true);
    const setting = FLIPPABLE_SETTINGS.find(entry => entry.field === "allowRuntimeFailover");
    expect(setting).toMatchObject({ runtime: false, broadcast: true });
    expect(setting?.validate.safeParse(true).success).toBe(true);
    expect(setting?.validate.safeParse("true").success).toBe(false);
    expect(BROADCAST_KEYS.has("allowRuntimeFailover")).toBe(true);
  });

  it("rejects a tampered exact descriptor before default-off recovery can requeue it", async () => {
    const tampered = {
      id: "op_failover_integrity_unit",
      lane: "background",
      runtimeDescriptor: {
        kind: "delegated-op",
        adapter: "provider-exact",
        provider: "local",
        credentialProvider: "local",
        authSource: "sentinel",
        model: "tampered-model",
        runtime: "openai-compat",
        target: { kind: "local-config", endpointFingerprint: "a".repeat(64) },
        integrity: { scheme: "hmac-sha256-v1", mac: "tampered" },
      },
    } as Op;

    await expect(attemptRuntimeFailover(tampered, "http_503"))
      .rejects.toThrow("delegated runtime integrity check failed");
  });

  it.each([
    [{ lane: "interactive" as const }, "interactive lane"],
    [{ normalizedFailure: null }, "unknown failure"],
    [{ pinned: true }, "explicit target pin"],
    [{ controlPending: true }, "user control"],
    [{ ambiguousSideEffect: true }, "ambiguous side effect"],
  ])("blocks crossing on %s", (override, _label) => {
    expect(failoverPolicyAllows({ ...base, ...override })).toBe(false);
  });
});

describe("runtime failover candidate eligibility", () => {
  it("requires every requested capability and measured context floor", () => {
    expect(targetMeetsRequirements({
      needsTools: true,
      needsVision: true,
      needsStreaming: true,
      needsJsonMode: true,
      needsLocalFiles: true,
      minimumContextTokens: 128_000,
    }, capable, true)).toBe(true);
    for (const field of ["tools", "vision", "streaming", "jsonMode", "localFiles"] as const) {
      expect(targetMeetsRequirements({ [`needs${field[0].toUpperCase()}${field.slice(1)}`]: true }, {
        ...capable,
        [field]: "unknown",
      }, true)).toBe(false);
    }
    expect(targetMeetsRequirements({ minimumContextTokens: 200_001 }, capable, true)).toBe(false);
  });

  it("enforces strict local-only and exact local certification", () => {
    expect(targetMeetsRequirements({ locality: "local-only" }, capable, true)).toBe(false);
    const local = { ...capable, locality: "local" as const };
    expect(targetMeetsRequirements({ locality: "local-only" }, local, false)).toBe(false);
    expect(targetMeetsRequirements({ locality: "local-only" }, local, true)).toBe(true);
  });

  it("rejects learned tool rejection even if older facts claimed support", () => {
    expect(targetMeetsRequirements({ needsTools: true }, {
      ...capable,
      tools: "unsupported",
      toolsRejected: true,
    }, true)).toBe(false);
  });
});

describe("runtime failover budget matrix", () => {
  const open = {
    dailyBudgetUsd: 10,
    sessionBudgetUsd: 5,
    modelBudgetUsd: 3,
    todaySpent: 1,
    sessionSpent: 1,
    modelSpent: 1,
  };

  it("admits configured billable capacity and rejects each exhausted cap", () => {
    expect(candidateWithinBudget("env", "m", "s", open)).toBe(true);
    expect(candidateWithinBudget("env", "m", "s", { ...open, todaySpent: 10 })).toBe(false);
    expect(candidateWithinBudget("env", "m", "s", { ...open, sessionSpent: 5 })).toBe(false);
    expect(candidateWithinBudget("env", "m", "s", { ...open, modelSpent: 3 })).toBe(false);
  });

  it("requires an explicit positive cap before admitting a billable fallback", () => {
    const uncapped = {
      dailyBudgetUsd: 0,
      sessionBudgetUsd: 0,
      modelBudgetUsd: 0,
      todaySpent: 0,
      sessionSpent: 0,
      modelSpent: 0,
    };
    expect(candidateWithinBudget("env", "m", "s", uncapped)).toBe(false);
    expect(candidateWithinBudget("env", "m", "s", { ...uncapped, dailyBudgetUsd: 1 })).toBe(true);
  });

  it("does not invent API spend for subscription or local runtimes", () => {
    const exhausted = { ...open, todaySpent: 100, sessionSpent: 100, modelSpent: 100 };
    expect(candidateWithinBudget("oauth", "m", "s", exhausted)).toBe(true);
    expect(candidateWithinBudget("sentinel", "m", "s", exhausted)).toBe(true);
  });
});

describe("runtime failover durable state", () => {
  it("persists an exact candidate and monotonic cooldown revision", () => {
    const first = buildRuntimeFailoverState({
      phase: "cooldown",
      currentTargetIdentity: "target-b",
      candidateTargetIdentity: "target-b",
      attemptedTargetIdentities: ["target-a", "target-b", "target-b"],
      normalizedFailure: "timeout",
      retryNotBefore: "2026-07-20T12:00:00.000Z",
      priorRevision: 4,
    });
    expect(first).toEqual(expect.objectContaining({
      phase: "cooldown",
      currentTargetIdentity: "target-b",
      candidateTargetIdentity: "target-b",
      attemptedTargetIdentities: ["target-a", "target-b"],
      revision: 5,
    }));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it("keeps exhausted candidates waiting and isolates concurrent operations", () => {
    const opA = buildRuntimeFailoverState({
      phase: "waiting", currentTargetIdentity: "a", candidateTargetIdentity: null,
      attemptedTargetIdentities: ["a", "b"], normalizedFailure: "overloaded",
      retryNotBefore: "2026-07-20T12:01:00.000Z",
    });
    const opB = buildRuntimeFailoverState({
      phase: "waiting", currentTargetIdentity: "x", candidateTargetIdentity: null,
      attemptedTargetIdentities: ["x"], normalizedFailure: "timeout",
      retryNotBefore: "2026-07-20T12:02:00.000Z",
    });
    opA.attemptedTargetIdentities.push("c");
    expect(opB.attemptedTargetIdentities).toEqual(["x"]);
    expect(opA.candidateTargetIdentity).toBeNull();
  });

  it("survives restart cooldown and reopens an exhausted epoch for eventual recovery", () => {
    const state = buildRuntimeFailoverState({
      phase: "waiting", currentTargetIdentity: "b", candidateTargetIdentity: null,
      attemptedTargetIdentities: ["a", "b", "c"], normalizedFailure: "timeout",
      retryNotBefore: "2026-07-20T12:01:00.000Z",
      priorRevision: 2,
    });
    const restarted = JSON.parse(JSON.stringify(state));
    expect([...attemptedTargetsForEpoch("b", restarted, Date.parse("2026-07-20T12:00:59.000Z"))])
      .toEqual(["a", "b", "c"]);
    expect([...attemptedTargetsForEpoch("b", restarted, Date.parse("2026-07-20T12:01:00.000Z"))])
      .toEqual(["b"]);
  });

  it("drops provider-native continuation state only across the exact failover boundary", () => {
    const prior = { adapterName: "old", adapterVersion: "1", providerPayload: { cursor: "old" } };
    expect(providerStateAcrossRuntimeBoundary(true, prior)).toBeUndefined();
    expect(providerStateAcrossRuntimeBoundary(false, prior)).toBe(prior);
  });

  it("rejects a restart boundary that does not match the signed exact target", () => {
    const descriptor = {
      kind: "delegated-op", adapter: "provider-exact", provider: "xai",
      credentialProvider: "xai", authSource: "oauth", model: "grok-4.5",
      runtime: "openai-compat",
      target: { kind: "provider-registry", endpointFingerprint: "a".repeat(64) },
      integrity: { scheme: "hmac-sha256-v1", mac: "b".repeat(64) },
    } as ExactDelegatedRuntimeDescriptor;
    const identity = JSON.stringify(["xai", "grok-4.5", "provider-registry", "a".repeat(64)]);
    const state = buildRuntimeFailoverState({
      phase: "cooldown", currentTargetIdentity: identity, candidateTargetIdentity: identity,
      attemptedTargetIdentities: [identity], normalizedFailure: "timeout",
      retryNotBefore: "2026-07-20T12:01:00.000Z",
    });
    expect(isRuntimeFailoverBoundary({ canonical: { runtimeFailover: state } } as Op, descriptor)).toBe(true);
    state.currentTargetIdentity = "different";
    expect(isRuntimeFailoverBoundary({ canonical: { runtimeFailover: state } } as Op, descriptor)).toBe(false);
  });
});
