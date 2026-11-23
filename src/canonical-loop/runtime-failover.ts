import { getRuntimeConfig } from "../config.js";
import {
  getBillableCostForModelSince,
  getSessionBillableCost,
  getTodayBillableCost,
  isBillableSource,
} from "../cost-tracker.js";
import { readOp, tryWithOpLock, writeOpStrict } from "../ops/op-store.js";
import { resolveOperationRequirements } from "../ops/operation-requirements.js";
import { resourceLocksForProvider } from "../ops/provider-matrix.js";
import { runtimeTargetIdentity } from "../ops/target-identity.js";
import type { ExactDelegatedRuntimeDescriptor, Op } from "../ops/types.js";
import { getSetting } from "../settings.js";
import { normalizeRuntimeFailure } from "./runtime-failure-category.js";
import { hasAmbiguousSideEffects } from "../tool-execution/side-effect-journal.js";
import { targetMeetsRequirements } from "./target-requirements.js";
import { registerAdapterForOp, releaseRuntimeSurfaceForRetry } from "./runtime.js";
import { createRecoveredAdapterFactory } from "./runtime-reconstruction.js";
import { verifyDelegatedRuntimeIntegrity } from "./runtime-integrity.js";
import { readOpMessages } from "./store.js";
import type { RuntimeFailoverState } from "./types.js";
import type { ProviderId } from "../providers/provider-ids.js";
import {
  enumerateFailoverCandidates,
  exactLocalCertification,
  failoverProviderAllowed,
  type FailoverCandidate,
} from "./runtime-failover-candidates.js";
import {
  appendRuntimeRoutingFeedback,
  createRuntimeRoutingFeedback,
} from "./runtime-routing-feedback.js";

const WAIT_MS = 60_000;
const FAILOVER_FAILURES = new Set([
  "auth", "billing", "model_not_found", "overloaded", "rate_limit", "server_error", "timeout",
]);
const ROUTING_FEEDBACK_FAILURES = new Set([
  "model_not_found", "overloaded", "rate_limit", "server_error", "timeout",
]);

export function resourceLocksAfterRuntimeFailover(
  locks: readonly string[] | undefined,
  priorProvider: string,
  nextProvider: string,
): string[] {
  const priorProviderLocks = new Set(resourceLocksForProvider(priorProvider));
  const durable = (locks ?? []).filter(lock => !priorProviderLocks.has(lock));
  return Array.from(new Set([...durable, ...resourceLocksForProvider(nextProvider)]));
}
export type FailoverResult =
  | { kind: "switched"; delayMs: number; targetIdentity: string; provider: ProviderId; model: string }
  | { kind: "waiting"; delayMs: number }
  | { kind: "ineligible" };

export function runtimeFailoverEnabled(value = getSetting<boolean>("allowRuntimeFailover")): boolean {
  return value === true;
}

export function failoverPolicyAllows(input: {
  lane: Op["lane"];
  normalizedFailure: string | null;
  pinned: boolean;
  controlPending: boolean;
  ambiguousSideEffect: boolean;
}): boolean {
  return input.lane !== "interactive"
    && !!input.normalizedFailure
    && FAILOVER_FAILURES.has(input.normalizedFailure)
    && !input.pinned
    && !input.controlPending
    && !input.ambiguousSideEffect;
}

export function candidateWithinBudget(
  authSource: ExactDelegatedRuntimeDescriptor["authSource"],
  model: string,
  sessionId: string,
  facts: {
    dailyBudgetUsd: number; sessionBudgetUsd: number; modelBudgetUsd: number;
    todaySpent: number; sessionSpent: number; modelSpent: number;
  },
): boolean {
  void sessionId;
  if (!isBillableSource(authSource)) return true;
  if (facts.dailyBudgetUsd <= 0 && facts.sessionBudgetUsd <= 0 && facts.modelBudgetUsd <= 0) return false;
  if (facts.dailyBudgetUsd > 0 && facts.todaySpent >= facts.dailyBudgetUsd) return false;
  if (facts.sessionBudgetUsd > 0 && facts.sessionSpent >= facts.sessionBudgetUsd) return false;
  if (facts.modelBudgetUsd > 0 && facts.modelSpent >= facts.modelBudgetUsd) return false;
  return true;
}

export function buildRuntimeFailoverState(input: {
  phase: RuntimeFailoverState["phase"];
  currentTargetIdentity: string;
  candidateTargetIdentity: string | null;
  attemptedTargetIdentities: Iterable<string>;
  normalizedFailure: string;
  retryNotBefore: string;
  priorRevision?: number;
  priorFeedback?: RuntimeFailoverState["feedback"];
  nextFeedback?: NonNullable<RuntimeFailoverState["feedback"]>[number] | null;
}): RuntimeFailoverState {
  const feedback = appendRuntimeRoutingFeedback(input.priorFeedback, input.nextFeedback ?? null);
  return {
    schemaVersion: 1,
    phase: input.phase,
    currentTargetIdentity: input.currentTargetIdentity,
    candidateTargetIdentity: input.candidateTargetIdentity,
    attemptedTargetIdentities: [...new Set(input.attemptedTargetIdentities)],
    normalizedFailure: input.normalizedFailure,
    retryNotBefore: input.retryNotBefore,
    revision: (input.priorRevision ?? 0) + 1,
    ...(feedback.length ? { feedback } : {}),
  };
}

export function runtimeFailureFeedsRouting(normalized: string): boolean {
  return ROUTING_FEEDBACK_FAILURES.has(normalized);
}

export function attemptedTargetsForEpoch(
  currentIdentity: string,
  state: RuntimeFailoverState | undefined,
  now: number,
): Set<string> {
  return new Set(
    state?.phase === "waiting" && Date.parse(state.retryNotBefore) <= now
      ? [currentIdentity]
      : [...(state?.attemptedTargetIdentities ?? []), currentIdentity],
  );
}

export function validatePersistedFailoverTarget(
  op: Op,
  descriptor: ExactDelegatedRuntimeDescriptor,
): boolean {
  const resolved = resolveOperationRequirements(op, readOpMessages(op.id));
  const snapshot = descriptor.capabilitySnapshot;
  return !resolved.pinnedTarget
    && failoverProviderAllowed(descriptor.provider)
    && !!snapshot
    && targetMeetsRequirements(resolved.requirements, snapshot, exactLocalCertification(descriptor), descriptor.model)
    && liveBudgetAllows(descriptor, op.canonical?.sessionId ?? op.sessionId ?? "")
    && !hasAmbiguousSideEffects(op.id);
}

export async function attemptRuntimeFailover(op: Op, reportedCode: string, message = ""): Promise<FailoverResult> {
  const normalized = normalizeRuntimeFailure(reportedCode, message);
  const persisted = readOp(op.id) ?? op;
  if (persisted.runtimeDescriptor?.kind === "delegated-op"
    && persisted.runtimeDescriptor.adapter === "provider-exact") {
    verifyDelegatedRuntimeIntegrity(persisted);
  }
  const resolved = resolveOperationRequirements(persisted, readOpMessages(op.id));
  if (!failoverPolicyAllows({
    lane: op.lane,
    normalizedFailure: normalized,
    pinned: !!resolved.pinnedTarget,
    controlPending: !!(persisted.canonical?.cancelRequestedAt || persisted.canonical?.pauseRequestedAt),
    ambiguousSideEffect: hasAmbiguousSideEffects(op.id),
  })) return { kind: "ineligible" };
  if (!runtimeFailoverEnabled()) return { kind: "ineligible" };
  if (persisted.runtimeDescriptor?.kind !== "delegated-op"
    || persisted.runtimeDescriptor.adapter !== "provider-exact") return { kind: "ineligible" };
  const current = persisted.runtimeDescriptor;
  const currentIdentity = runtimeTargetIdentity(current);
  const failover = persisted.canonical?.runtimeFailover;
  const now = Date.now();
  const attempted = attemptedTargetsForEpoch(currentIdentity, failover, now);
  const candidates = await enumerateFailoverCandidates(persisted, current, attempted);
  const selected = candidates.find(candidate => {
    const snapshot = candidate.descriptor.capabilitySnapshot;
    return !!snapshot && targetMeetsRequirements(resolved.requirements, snapshot, candidate.certified, candidate.descriptor.model)
      && liveBudgetAllows(candidate.descriptor, persisted.canonical?.sessionId ?? persisted.sessionId ?? "");
  });
  if (!selected) {
    await persistWaiting(persisted, current, currentIdentity, attempted, normalized!, now, now + WAIT_MS);
    return { kind: "waiting", delayMs: WAIT_MS };
  }
  const candidateIdentity = runtimeTargetIdentity(selected.descriptor);
  const delayMs = retryDelay(persisted);
  const persistedSwitch = tryWithOpLock(op.id, () => {
    const fresh = readOp(op.id);
    if (!fresh || fresh.canonical?.cancelRequestedAt || fresh.canonical?.pauseRequestedAt) return false;
    const requirements = resolveOperationRequirements(fresh, readOpMessages(op.id));
    if (requirements.pinnedTarget) return false;
    verifyDelegatedRuntimeIntegrity(fresh);
    if (runtimeTargetIdentity(fresh.runtimeDescriptor) !== currentIdentity) return false;
    fresh.runtimeDescriptor = selected.descriptor;
    fresh.model = selected.descriptor.model;
    fresh.resourceLocks = resourceLocksAfterRuntimeFailover(
      fresh.resourceLocks,
      current.provider,
      selected.descriptor.provider,
    );
    fresh.attemptCount = (fresh.attemptCount ?? 0) + 1;
    fresh.lastFailureAt = new Date(now).toISOString();
    fresh.lastFailureReason = `runtime_failover:${normalized}`;
    if (!fresh.canonical) fresh.canonical = {};
    fresh.canonical.retryNotBefore = new Date(now + delayMs).toISOString();
    fresh.canonical.runtimeFailover = buildRuntimeFailoverState({
      phase: "cooldown",
      currentTargetIdentity: candidateIdentity,
      candidateTargetIdentity: candidateIdentity,
      attemptedTargetIdentities: [...attempted, candidateIdentity],
      normalizedFailure: normalized!,
      retryNotBefore: fresh.canonical.retryNotBefore,
      priorRevision: failover?.revision,
      priorFeedback: failover?.feedback,
      nextFeedback: routingFailureFeedback(persisted, current, normalized!, now),
    });
    const written = writeOpStrict(fresh);
    if (written) Object.assign(op, fresh);
    return written;
  });
  if (!persistedSwitch.acquired || !persistedSwitch.value) return { kind: "ineligible" };
  registerAdapterForOp(op.id, createRecoveredAdapterFactory(
    op,
    selected.descriptor,
    () => releaseRuntimeSurfaceForRetry(op.id),
  ));
  return {
    kind: "switched",
    delayMs,
    targetIdentity: candidateIdentity,
    provider: selected.descriptor.provider,
    model: selected.descriptor.model,
  };
}

function liveBudgetAllows(descriptor: ExactDelegatedRuntimeDescriptor, sessionId: string): boolean {
  const cfg = getRuntimeConfig();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return candidateWithinBudget(descriptor.authSource, descriptor.model, sessionId, {
    dailyBudgetUsd: cfg.dailyBudgetUsd ?? 0,
    sessionBudgetUsd: cfg.sessionBudgetUsd ?? 0,
    modelBudgetUsd: cfg.modelDailyBudgetsUsd?.[descriptor.model] ?? 0,
    todaySpent: getTodayBillableCost().costUsd,
    sessionSpent: getSessionBillableCost(sessionId).costUsd,
    modelSpent: getBillableCostForModelSince(descriptor.model, start.getTime()),
  });
}

async function persistWaiting(
  op: Op,
  descriptor: ExactDelegatedRuntimeDescriptor,
  currentIdentity: string,
  attempted: ReadonlySet<string>,
  normalized: string,
  recordedAt: number,
  retryAt: number,
): Promise<void> {
  const result = tryWithOpLock(op.id, () => {
    const fresh = readOp(op.id) ?? op;
    verifyDelegatedRuntimeIntegrity(fresh);
    if (!fresh.canonical) fresh.canonical = {};
    const retryNotBefore = new Date(retryAt).toISOString();
    fresh.canonical.retryNotBefore = retryNotBefore;
    fresh.canonical.runtimeFailover = buildRuntimeFailoverState({
      phase: "waiting",
      currentTargetIdentity: currentIdentity,
      candidateTargetIdentity: null,
      attemptedTargetIdentities: [...attempted],
      normalizedFailure: normalized,
      retryNotBefore,
      priorRevision: fresh.canonical.runtimeFailover?.revision,
      priorFeedback: fresh.canonical.runtimeFailover?.feedback,
      nextFeedback: routingFailureFeedback(fresh, descriptor, normalized, recordedAt),
    });
    fresh.lastFailureAt = new Date().toISOString();
    fresh.lastFailureReason = `runtime_failover_waiting:${normalized}`;
    const written = writeOpStrict(fresh);
    if (written) Object.assign(op, fresh);
    return written;
  });
  if (!result.acquired || !result.value) throw new Error("runtime failover waiting state was not persisted");
}

function retryDelay(op: Op): number {
  const values = op.retryPolicy?.backoffMs ?? [];
  return values[Math.min(op.attemptCount ?? 0, Math.max(0, values.length - 1))] ?? 5_000;
}

function routingFailureFeedback(
  op: Op,
  descriptor: ExactDelegatedRuntimeDescriptor,
  normalized: string,
  recordedAt: number,
) {
  return runtimeFailureFeedsRouting(normalized)
    ? createRuntimeRoutingFeedback(op, descriptor, "failure", recordedAt)
    : null;
}
