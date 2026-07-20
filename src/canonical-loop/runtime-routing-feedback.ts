import { createHash } from "node:crypto";
import {
  getLocalRuntimeById,
  publishedCertificationSelectionHash,
} from "../local-runtimes/index.js";
import { listRecentOps } from "../ops/op-store.js";
import { resolveOperationRequirements } from "../ops/operation-requirements.js";
import { runtimeTargetIdentity } from "../ops/target-identity.js";
import type { ExactDelegatedRuntimeDescriptor, Op } from "../ops/types.js";
import { classifyOpCategory } from "../tool-tracker.js";
import { readTurnArtifact } from "./turn-commit-store.js";
import { readOpMessages, readOpTurns } from "./store.js";
import type { RuntimeRoutingFeedback } from "./types.js";

const MAX_EVIDENCE_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1_000;
const COOLDOWN_MS = 5 * 60 * 1_000;
const MIN_SAMPLES = 3;
const MIN_DECISIVE_SCORE = 0.5;
const MAX_OP_FEEDBACK = 8;
const MAX_SOURCE_OPS = 256;

export interface RuntimeRoutingFeedbackVerdict {
  sampleCount: number;
  score: number;
  cooldownUntil: number;
}

export interface RuntimeRoutingFeedbackSample {
  opId: string;
  feedback: RuntimeRoutingFeedback;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createRuntimeRoutingFeedback(
  op: Op,
  descriptor: ExactDelegatedRuntimeDescriptor,
  outcome: RuntimeRoutingFeedback["outcome"],
  recordedAt: number,
  extraToolNames: Iterable<string> = [],
): RuntimeRoutingFeedback | null {
  if (!Number.isSafeInteger(recordedAt) || recordedAt < 0) return null;
  if (!descriptor.target || typeof descriptor.target !== "object") return null;
  const routingIdentity = exactRoutingIdentity(descriptor);
  if (!routingIdentity) return null;
  const resolved = resolveOperationRequirements(
    { ...op, runtimeDescriptor: descriptor },
    readOpMessages(op.id),
  );
  const tools = new Set<string>();
  for (const turn of readOpTurns(op.id)) {
    for (const summary of turn.toolCallSummary ?? []) tools.add(summary.tool);
    for (const observed of turn.observedTools ?? []) tools.add(observed);
  }
  for (const tool of extraToolNames) tools.add(tool);
  return {
    schemaVersion: 1,
    routingIdentity,
    compatibilityKey: hash([op.lane, op.type, classifyOpCategory(tools), resolved.requirements]),
    outcome,
    recordedAt,
  };
}

export function appendRuntimeRoutingFeedback(
  previous: readonly RuntimeRoutingFeedback[] | undefined,
  next: RuntimeRoutingFeedback | null,
): RuntimeRoutingFeedback[] {
  const valid = (previous ?? []).filter(isRuntimeRoutingFeedback);
  if (next) valid.push(next);
  return valid.slice(-MAX_OP_FEEDBACK);
}

export function runtimeRoutingFeedbackVerdict(
  candidate: RuntimeRoutingFeedback,
  samples: readonly RuntimeRoutingFeedbackSample[],
  now: number,
): RuntimeRoutingFeedbackVerdict {
  const latestByOp = new Map<string, RuntimeRoutingFeedback>();
  for (const sample of samples) {
    const feedback = sample.feedback;
    if (!isRuntimeRoutingFeedback(feedback)
      || feedback.routingIdentity !== candidate.routingIdentity
      || feedback.compatibilityKey !== candidate.compatibilityKey
      || feedback.recordedAt > now
      || now - feedback.recordedAt > MAX_EVIDENCE_AGE_MS) continue;
    const prior = latestByOp.get(sample.opId);
    if (!prior || compareRuntimeRoutingFeedback(feedback, prior) > 0) {
      latestByOp.set(sample.opId, feedback);
    }
  }
  const recent = [...latestByOp.entries()]
    .sort((a, b) => b[1].recordedAt - a[1].recordedAt || a[0].localeCompare(b[0]));
  if (recent.length < MIN_SAMPLES) return { sampleCount: recent.length, score: 0, cooldownUntil: 0 };

  let weightedOutcome = 0;
  for (const [, feedback] of recent) {
    const decay = Math.pow(0.5, (now - feedback.recordedAt) / HALF_LIFE_MS);
    weightedOutcome += decay * (feedback.outcome === "success" ? 1 : -1);
  }
  const rawScore = weightedOutcome / recent.length;
  const score = Math.abs(rawScore) >= MIN_DECISIVE_SCORE ? rawScore : 0;
  const latestThreeFailed = recent.slice(0, MIN_SAMPLES)
    .every(([, feedback]) => feedback.outcome === "failure");
  const proposedCooldown = latestThreeFailed ? recent[0][1].recordedAt + COOLDOWN_MS : 0;
  const cooldownUntil = proposedCooldown > now ? proposedCooldown : 0;
  return { sampleCount: recent.length, score, cooldownUntil };
}

export function readRuntimeRoutingFeedbackVerdict(
  op: Op,
  descriptor: ExactDelegatedRuntimeDescriptor,
  now: number,
): RuntimeRoutingFeedbackVerdict {
  const candidate = createRuntimeRoutingFeedback(op, descriptor, "success", now);
  if (!candidate) return { sampleCount: 0, score: 0, cooldownUntil: 0 };
  const samples: RuntimeRoutingFeedbackSample[] = [];
  const historicalOps = listRecentOps(MAX_SOURCE_OPS);
  for (const historical of historicalOps) {
    if (historical.id === op.id) continue;
    const attemptFeedback = historical.canonical?.runtimeFailover?.feedback;
    for (const feedback of Array.isArray(attemptFeedback) ? attemptFeedback : []) {
      samples.push({ opId: historical.id, feedback });
    }
    const turnIdx = historical.canonical?.currentTurnIdx;
    if (!Number.isSafeInteger(turnIdx) || Number(turnIdx) < 0) continue;
    const artifact = readTurnArtifact(historical.id, Number(turnIdx));
    if (artifact && "turn" in artifact && artifact.projection.routingFeedback) {
      samples.push({ opId: historical.id, feedback: artifact.projection.routingFeedback });
    }
  }
  return runtimeRoutingFeedbackVerdict(candidate, samples, now);
}

function compareRuntimeRoutingFeedback(
  a: RuntimeRoutingFeedback,
  b: RuntimeRoutingFeedback,
): number {
  return a.recordedAt - b.recordedAt
    || compareText(a.routingIdentity, b.routingIdentity)
    || compareText(a.compatibilityKey, b.compatibilityKey)
    || compareText(a.outcome, b.outcome);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isRuntimeRoutingFeedback(value: unknown): value is RuntimeRoutingFeedback {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RuntimeRoutingFeedback>;
  return row.schemaVersion === 1
    && typeof row.routingIdentity === "string" && /^[a-f0-9]{64}$/.test(row.routingIdentity)
    && typeof row.compatibilityKey === "string" && /^[a-f0-9]{64}$/.test(row.compatibilityKey)
    && (row.outcome === "success" || row.outcome === "failure")
    && Number.isSafeInteger(row.recordedAt) && Number(row.recordedAt) >= 0;
}

function exactRoutingIdentity(descriptor: ExactDelegatedRuntimeDescriptor): string | null {
  let buildIdentity = "provider-managed";
  if (descriptor.target.kind === "local-runtime") {
    const runtime = getLocalRuntimeById(descriptor.target.runtimeId);
    const model = runtime?.models.find((candidate) => candidate.id === descriptor.model);
    if (!runtime || !model) return null;
    buildIdentity = publishedCertificationSelectionHash(runtime, model) ?? "";
    if (!buildIdentity) return null;
  }
  return hash([
    runtimeTargetIdentity(descriptor),
    descriptor.runtime,
    descriptor.credentialProvider,
    descriptor.authSource,
    descriptor.capabilitySnapshot,
    buildIdentity,
  ]);
}
