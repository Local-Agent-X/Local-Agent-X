import { describe, expect, it, vi } from "vitest";

const cert = vi.hoisted(() => ({ hash: "a".repeat(64) }));
vi.mock("../local-runtimes/index.js", () => ({
  getLocalRuntimeById: (id: string) => id === "runtime-a" ? {
    id,
    models: [{ id: "local-model", contextWindow: 8_192, tools: true }],
  } : null,
  publishedCertificationSelectionHash: () => cert.hash,
}));

import type { ExactDelegatedRuntimeDescriptor, Op } from "../ops/types.js";
import { runtimeTargetIdentity } from "../ops/target-identity.js";
import {
  appendRuntimeRoutingFeedback,
  createRuntimeRoutingFeedback,
  isRuntimeRoutingFeedback,
  runtimeRoutingFeedbackVerdict,
  type RuntimeRoutingFeedbackSample,
} from "./runtime-routing-feedback.js";
import { isTurnCommitEnvelope } from "./turn-commit-store.js";

const NOW = Date.UTC(2026, 6, 20, 12);
const DAY = 24 * 60 * 60 * 1_000;
let opSequence = 0;

function descriptor(
  model = "model-a",
  endpointFingerprint = "1".repeat(64),
  authSource: ExactDelegatedRuntimeDescriptor["authSource"] = "env",
): ExactDelegatedRuntimeDescriptor {
  const target = { kind: "provider-registry" as const, endpointFingerprint };
  return {
    kind: "delegated-op",
    adapter: "provider-exact",
    provider: "openai",
    credentialProvider: "openai",
    authSource,
    model,
    runtime: "openai-compat",
    target,
    capabilitySnapshot: {
      targetIdentity: runtimeTargetIdentity({ provider: "openai", model, target }),
      tools: "supported",
      toolsRejected: false,
      vision: "supported",
      streaming: "supported",
      jsonMode: "supported",
      localFiles: "unsupported",
      contextWindowTokens: 128_000,
      locality: "remote",
    },
    integrity: { scheme: "hmac-sha256-v1", mac: "f".repeat(64) },
  };
}

function op(runtimeDescriptor = descriptor(), capabilities: Op["contextPack"]["capabilities"] = {}): Op {
  return {
    id: `feedback-${++opSequence}`,
    type: "research",
    task: "content never enters feedback",
    contextPack: {
      task: { description: "private", successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "private" },
      capabilities,
      budget: { maxIterations: 10, maxTokens: 10_000, maxWallTimeMs: 10_000, maxSelfEditCalls: 1 },
      routing: { lane: "background" },
      secrets: { allowed: ["SECRET_NAME"] },
    },
    lane: "background",
    retryPolicy: { maxRecoveryAttempts: 10, backoffMs: [1_000] },
    runtimeDescriptor,
    ownerId: "owner",
    visibility: "private",
    status: "running",
    createdAt: new Date(NOW).toISOString(),
    attemptCount: 0,
  };
}

function receipt(
  targetOp: Op,
  target = targetOp.runtimeDescriptor as ExactDelegatedRuntimeDescriptor,
  outcome: "success" | "failure" = "success",
  recordedAt = NOW,
) {
  return createRuntimeRoutingFeedback(targetOp, target, outcome, recordedAt)!;
}

function samples(candidate: ReturnType<typeof receipt>, outcomes: Array<"success" | "failure">): RuntimeRoutingFeedbackSample[] {
  return outcomes.map((outcome, index) => ({
    opId: `op-${index}`,
    feedback: { ...candidate, outcome, recordedAt: NOW - index * 1_000 },
  }));
}

describe("exact runtime routing feedback identity", () => {
  it("skips a legacy provider-exact descriptor without a target", () => {
    const legacy = { ...descriptor(), target: undefined } as unknown as ExactDelegatedRuntimeDescriptor;
    expect(createRuntimeRoutingFeedback(op(), legacy, "success", NOW)).toBeNull();
  });

  it("isolates endpoint, model, credential source, capabilities, and requirement drift", () => {
    const baseOp = op();
    const base = receipt(baseOp);
    expect(receipt(op(descriptor("model-a", "2".repeat(64)))).routingIdentity).not.toBe(base.routingIdentity);
    expect(receipt(op(descriptor("model-b"))).routingIdentity).not.toBe(base.routingIdentity);
    expect(receipt(op(descriptor("model-a", "1".repeat(64), "oauth"))).routingIdentity).not.toBe(base.routingIdentity);
    const changedCaps = descriptor();
    changedCaps.capabilitySnapshot = { ...changedCaps.capabilitySnapshot!, contextWindowTokens: 64_000 };
    expect(receipt(op(changedCaps)).routingIdentity).not.toBe(base.routingIdentity);
    expect(receipt(op(descriptor(), { needsTools: true })).compatibilityKey).not.toBe(base.compatibilityKey);
    expect(receipt(op(descriptor(), { minimumContextTokens: 64_000 })).compatibilityKey).not.toBe(base.compatibilityKey);
    const categoryOp = op();
    const coding = createRuntimeRoutingFeedback(categoryOp, descriptor(), "success", NOW, ["bash"]);
    const research = createRuntimeRoutingFeedback(categoryOp, descriptor(), "success", NOW, ["web_fetch"]);
    expect(coding?.compatibilityKey).not.toBe(research?.compatibilityKey);
  });

  it("isolates exact local certification build drift", () => {
    const localTarget = { kind: "local-runtime" as const, runtimeId: "runtime-a", endpointFingerprint: "3".repeat(64) };
    const local = descriptor("local-model", localTarget.endpointFingerprint, "sentinel");
    local.provider = "local";
    local.credentialProvider = "local";
    local.target = localTarget;
    local.capabilitySnapshot = {
      ...local.capabilitySnapshot!,
      targetIdentity: runtimeTargetIdentity(local),
      locality: "local",
    };
    const targetOp = op(local, { locality: "local-only" });
    const before = receipt(targetOp, local);
    cert.hash = "b".repeat(64);
    const after = receipt(targetOp, local);
    expect(after.routingIdentity).not.toBe(before.routingIdentity);
    cert.hash = "a".repeat(64);
  });

  it("contains only fixed routing facts and never prompt, args, or secret names", () => {
    const serialized = JSON.stringify(receipt(op()));
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("SECRET_NAME");
    expect(Object.keys(JSON.parse(serialized))).toEqual([
      "schemaVersion", "routingIdentity", "compatibilityKey", "outcome", "recordedAt",
    ]);
  });
});

describe("bounded evidence interpretation", () => {
  it("keeps only eight valid per-operation receipts", () => {
    const candidate = receipt(op());
    const history = [
      { ...candidate, routingIdentity: "bad" },
      ...Array.from({ length: 10 }, (_, index) => ({ ...candidate, recordedAt: NOW + index })),
    ];
    const bounded = appendRuntimeRoutingFeedback(history, null);
    expect(bounded).toHaveLength(8);
    expect(bounded.map((item) => item.recordedAt)).toEqual(
      Array.from({ length: 8 }, (_, index) => NOW + index + 2),
    );
  });

  it("keeps sparse evidence neutral and requires a decisive sample", () => {
    const candidate = receipt(op());
    expect(runtimeRoutingFeedbackVerdict(candidate, samples(candidate, ["failure"]), NOW)).toEqual({
      sampleCount: 1, score: 0, cooldownUntil: 0,
    });
    expect(runtimeRoutingFeedbackVerdict(candidate, samples(candidate, ["success", "failure", "success"]), NOW).score).toBe(0);
    expect(runtimeRoutingFeedbackVerdict(candidate, samples(candidate, ["success", "success", "success"]), NOW).score).toBeGreaterThan(0);
  });

  it("does not latch alternating outcomes and gives three recent failures a bounded cooldown", () => {
    const candidate = receipt(op());
    expect(runtimeRoutingFeedbackVerdict(candidate, samples(candidate, ["success", "failure", "success", "failure"]), NOW).score).toBe(0);
    const failed = runtimeRoutingFeedbackVerdict(candidate, samples(candidate, ["failure", "failure", "failure"]), NOW);
    expect(failed.score).toBeLessThan(0);
    expect(failed.cooldownUntil).toBe(NOW + 5 * 60 * 1_000);
  });

  it("decays even unanimous evidence back to neutral", () => {
    const candidate = receipt(op());
    const stale = samples(candidate, ["failure", "failure", "failure"])
      .map((sample) => ({
        ...sample,
        feedback: { ...sample.feedback, recordedAt: sample.feedback.recordedAt - 4 * DAY },
      }));
    expect(runtimeRoutingFeedbackVerdict(candidate, stale, NOW)).toMatchObject({
      sampleCount: 3,
      score: 0,
      cooldownUntil: 0,
    });
  });

  it("rejects expired, future, corrupt, incompatible, and duplicate-op evidence", () => {
    const candidate = receipt(op());
    const invalid = [
      { opId: "expired", feedback: { ...candidate, recordedAt: NOW - 15 * DAY } },
      { opId: "future", feedback: { ...candidate, recordedAt: NOW + 1 } },
      { opId: "corrupt", feedback: { ...candidate, outcome: "skip" as never } },
      { opId: "other", feedback: { ...candidate, compatibilityKey: "9".repeat(64) } },
      { opId: "same", feedback: { ...candidate, outcome: "failure" as const, recordedAt: NOW - 1 } },
      { opId: "same", feedback: { ...candidate, outcome: "success" as const, recordedAt: NOW } },
    ];
    expect(runtimeRoutingFeedbackVerdict(candidate, invalid, NOW)).toEqual({
      sampleCount: 1, score: 0, cooldownUntil: 0,
    });
    expect(isRuntimeRoutingFeedback({ ...candidate, outcome: "timeout" })).toBe(false);
  });

  it("is deterministic across concurrent ordering and JSON restart", () => {
    const candidate = receipt(op());
    const concurrent = samples(candidate, ["success", "success", "success", "failure"]);
    const restarted = JSON.parse(JSON.stringify(concurrent)).reverse();
    expect(runtimeRoutingFeedbackVerdict(candidate, concurrent, NOW))
      .toEqual(runtimeRoutingFeedbackVerdict(candidate, restarted, NOW));
  });

  it("totally orders equal-time receipts from the same operation", () => {
    const candidate = receipt(op());
    const tied: RuntimeRoutingFeedbackSample[] = [
      { opId: "same", feedback: { ...candidate, outcome: "failure" } },
      { opId: "same", feedback: { ...candidate, outcome: "success" } },
      { opId: "success-a", feedback: { ...candidate, outcome: "success", recordedAt: NOW - 1 } },
      { opId: "success-b", feedback: { ...candidate, outcome: "success", recordedAt: NOW - 2 } },
    ];
    const forward = runtimeRoutingFeedbackVerdict(candidate, tied, NOW);
    const reversed = runtimeRoutingFeedbackVerdict(candidate, [...tied].reverse(), NOW);
    expect(forward).toEqual(reversed);
    expect(forward).toMatchObject({ sampleCount: 3, score: expect.any(Number) });
    expect(forward.score).toBeGreaterThan(0);
  });
});

describe("committed outcome projection", () => {
  it("accepts a valid content-free receipt and rejects a malformed one", () => {
    const feedback = receipt(op());
    const envelope = {
      schemaVersion: 1 as const,
      turn: {
        opId: "op-commit",
        turnIdx: 0,
        providerState: { adapterName: "test", adapterVersion: "1", providerPayload: null },
        toolCallSummary: [],
        terminalReason: "done" as const,
        redirectConsumed: false,
        createdAt: new Date(NOW).toISOString(),
      },
      messages: [],
      projection: {
        opType: "research",
        task: "not copied into feedback",
        sessionId: "session",
        learnedOutcome: "clean" as const,
        routingFeedback: feedback,
      },
    };
    expect(isTurnCommitEnvelope(envelope)).toBe(true);
    expect(isTurnCommitEnvelope({
      ...envelope,
      projection: { ...envelope.projection, routingFeedback: { ...feedback, outcome: "timeout" } },
    })).toBe(false);
  });
});
