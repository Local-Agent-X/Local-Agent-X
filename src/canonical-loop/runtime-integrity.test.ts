import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetAuditKeyCacheForTests } from "../app-runtime/audit-signing.js";
import type { ExactDelegatedRuntimeDescriptor, Op } from "../ops/types.js";
import { sealDelegatedRuntime, verifyDelegatedRuntimeIntegrity } from "./runtime-integrity.js";

const AUDIT_KEY = "runtime-integrity-test-key";
let previousAuditKey: string | undefined;

function descriptor(opId: string): ExactDelegatedRuntimeDescriptor {
  return sealDelegatedRuntime(opId, {
    kind: "delegated-op",
    adapter: "provider-exact",
    provider: "local",
    credentialProvider: "local",
    authSource: "sentinel",
    model: "exact-model",
    runtime: "openai-compat",
    target: { kind: "local-config", endpointFingerprint: "1".repeat(64) },
    sessionId: "session-exact",
    surface: {
      kind: "agent-runner",
      systemPrompt: "Persist this exact prompt.",
      tools: [{ name: "write", fingerprint: "2".repeat(64) }],
      security: {
        workspace: "C:/workspace/exact",
        fileAccessMode: "workspace",
        inlineEvalPolicy: "refuse",
        allowedPaths: [],
        configFingerprint: "3".repeat(64),
      },
      threatEngine: false,
      rbac: true,
      callContext: "api",
    },
  });
}

function opWithDescriptor(): Op {
  const id = "op_integrity_exact";
  return { id, runtimeDescriptor: descriptor(id) } as Op;
}

beforeEach(() => {
  previousAuditKey = process.env.LAX_AUDIT_KEY;
  process.env.LAX_AUDIT_KEY = AUDIT_KEY;
  _resetAuditKeyCacheForTests();
});

afterEach(() => {
  if (previousAuditKey === undefined) delete process.env.LAX_AUDIT_KEY;
  else process.env.LAX_AUDIT_KEY = previousAuditKey;
  _resetAuditKeyCacheForTests();
});

describe("delegated runtime durable integrity", () => {
  it("accepts the intact descriptor", () => {
    expect(() => verifyDelegatedRuntimeIntegrity(opWithDescriptor())).not.toThrow();
  });

  it.each([
    ["workspace", (d: ExactDelegatedRuntimeDescriptor) => { d.surface!.security.workspace = "C:/attacker"; }],
    ["tool", (d: ExactDelegatedRuntimeDescriptor) => { d.surface!.tools[0].name = "bash"; }],
    ["system prompt", (d: ExactDelegatedRuntimeDescriptor) => { d.surface!.systemPrompt = "attacker prompt"; }],
    ["threat state", (d: ExactDelegatedRuntimeDescriptor) => { d.surface!.threatEngine = {
      state: {
        scorer: {
          events: [], rawLoad: 0, lastEventAt: null, successfulTurnsSinceLastEvent: 0,
          confirmedBreach: false, options: { startingBudget: 60, decayPerHour: 5, decayPerTurn: 1 },
        },
        chain: {
          history: [], callHashes: [], userConsentActiveUntil: 0,
          lastBlockedFingerprint: null, lastBlockedAt: null,
        },
        canaries: ["canary-token"],
      },
    }; }],
    ["RBAC flag", (d: ExactDelegatedRuntimeDescriptor) => { d.surface!.rbac = false; }],
  ])("rejects a tampered %s", (_label, mutate) => {
    const op = opWithDescriptor();
    mutate(op.runtimeDescriptor as ExactDelegatedRuntimeDescriptor);
    expect(() => verifyDelegatedRuntimeIntegrity(op)).toThrow("delegated runtime integrity check failed");
  });
});
