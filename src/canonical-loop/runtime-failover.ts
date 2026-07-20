import { resolveCredential } from "../auth/resolve.js";
import { getRuntimeConfig } from "../config.js";
import { resolveContextWindow } from "../context-manager/model-windows.js";
import {
  getBillableCostForModelSince,
  getSessionBillableCost,
  getTodayBillableCost,
  isBillableSource,
} from "../cost-tracker.js";
import { isLocalOnlyMode, localProviderDecision } from "../local-only-policy.js";
import { getLocalRuntimes, hasPublishedCertification } from "../local-runtimes/index.js";
import { readOp, tryWithOpLock, writeOpStrict } from "../ops/op-store.js";
import { resolveOperationRequirements, type TargetCapabilitySnapshot } from "../ops/operation-requirements.js";
import { resourceLocksForProvider } from "../ops/provider-matrix.js";
import { runtimeTargetIdentity } from "../ops/target-identity.js";
import type { ExactDelegatedRuntimeDescriptor, Op, ProviderCapabilityRequirement } from "../ops/types.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";
import { PROVIDERS } from "../providers/registry.js";
import { getSetting } from "../settings.js";
import { hasAmbiguousSideEffects } from "../tool-execution/side-effect-journal.js";
import { resolveProviderRuntime } from "./provider-adapter-factory.js";
import { registerAdapterForOp, releaseRuntimeSurfaceForRetry } from "./runtime.js";
import { createRecoveredAdapterFactory } from "./runtime-reconstruction.js";
import { sealDelegatedRuntime, verifyDelegatedRuntimeIntegrity } from "./runtime-integrity.js";
import { readOpMessages } from "./store.js";
import type { RuntimeFailoverState } from "./types.js";

const WAIT_MS = 60_000;
const FAILOVER_FAILURES = new Set([
  "auth", "billing", "model_not_found", "overloaded", "rate_limit", "server_error", "timeout",
]);

export interface FailoverCandidate {
  descriptor: ExactDelegatedRuntimeDescriptor;
  certified: boolean;
}

export type FailoverResult =
  | { kind: "switched"; delayMs: number; targetIdentity: string }
  | { kind: "waiting"; delayMs: number }
  | { kind: "ineligible" };

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

export function normalizeRuntimeFailure(code: string, message = ""): string | null {
  const haystack = `${code} ${message}`.toLowerCase().replace(/[_-]+/g, " ");
  if (/\b(approval|policy|security|verification|content_filter|cancel|abort)\b/.test(haystack)) return null;
  if (/\b(401|403|unauthorized|forbidden|authentication|invalid api key|expired token)\b/.test(haystack)) return "auth";
  if (/\b(402|billing|payment|credit.*exhausted)\b/.test(haystack)) return "billing";
  if (/\b(404|model[_ -]?not[_ -]?found|invalid model|unknown model)\b/.test(haystack)) return "model_not_found";
  if (/\b(429|rate[_ -]?limit|too many requests|quota.*throttl)\b/.test(haystack)) return "rate_limit";
  if (/\b(503|529|overloaded|service unavailable|capacity)\b/.test(haystack)) return "overloaded";
  if (/\b(500|502|server[_ -]?error|internal server error|bad gateway|upstream error)\b/.test(haystack)) return "server_error";
  if (/\b(timeout|timed out|econnreset|econnrefused|etimedout|socket hang up|runtime reconstruction unavailable)\b/.test(haystack)) return "timeout";
  return null;
}

export function targetMeetsRequirements(
  requirements: ProviderCapabilityRequirement,
  capabilities: TargetCapabilitySnapshot,
  certified: boolean,
): boolean {
  if (capabilities.locality === "local" && !certified) return false;
  if (requirements.locality === "local-only" && capabilities.locality !== "local") return false;
  if (requirements.needsTools && capabilities.tools !== "supported") return false;
  if (requirements.needsVision && capabilities.vision !== "supported") return false;
  if (requirements.needsStreaming && capabilities.streaming !== "supported") return false;
  if (requirements.needsJsonMode && capabilities.jsonMode !== "supported") return false;
  if (requirements.needsLocalFiles && capabilities.localFiles !== "supported") return false;
  if (requirements.minimumContextTokens && (
    capabilities.contextWindowTokens === null
    || capabilities.contextWindowTokens < requirements.minimumContextTokens
  )) return false;
  return true;
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
}): RuntimeFailoverState {
  return {
    schemaVersion: 1,
    phase: input.phase,
    currentTargetIdentity: input.currentTargetIdentity,
    candidateTargetIdentity: input.candidateTargetIdentity,
    attemptedTargetIdentities: [...new Set(input.attemptedTargetIdentities)],
    normalizedFailure: input.normalizedFailure,
    retryNotBefore: input.retryNotBefore,
    revision: (input.priorRevision ?? 0) + 1,
  };
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
    && providerAllowed(descriptor.provider)
    && !!snapshot
    && targetMeetsRequirements(resolved.requirements, snapshot, exactLocalCertification(descriptor))
    && liveBudgetAllows(descriptor, op.canonical?.sessionId ?? op.sessionId ?? "")
    && !hasAmbiguousSideEffects(op.id);
}

export async function attemptRuntimeFailover(op: Op, reportedCode: string, message = ""): Promise<FailoverResult> {
  const normalized = normalizeRuntimeFailure(reportedCode, message);
  const persisted = readOp(op.id) ?? op;
  const resolved = resolveOperationRequirements(persisted, readOpMessages(op.id));
  if (!failoverPolicyAllows({
    lane: op.lane,
    normalizedFailure: normalized,
    pinned: !!resolved.pinnedTarget,
    controlPending: !!(persisted.canonical?.cancelRequestedAt || persisted.canonical?.pauseRequestedAt),
    ambiguousSideEffect: hasAmbiguousSideEffects(op.id),
  })) return { kind: "ineligible" };
  verifyDelegatedRuntimeIntegrity(persisted);
  const current = persisted.runtimeDescriptor;
  const currentIdentity = runtimeTargetIdentity(current);
  const failover = persisted.canonical?.runtimeFailover;
  const now = Date.now();
  const attempted = attemptedTargetsForEpoch(currentIdentity, failover, now);
  const candidates = await enumerateCandidates(persisted, current, attempted);
  const selected = candidates.find(candidate => {
    const snapshot = candidate.descriptor.capabilitySnapshot;
    return !!snapshot && targetMeetsRequirements(resolved.requirements, snapshot, candidate.certified)
      && liveBudgetAllows(candidate.descriptor, persisted.canonical?.sessionId ?? persisted.sessionId ?? "");
  });
  if (!selected) {
    await persistWaiting(persisted, currentIdentity, attempted, normalized!, now + WAIT_MS);
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
    fresh.resourceLocks = resourceLocksForProvider(selected.descriptor.provider);
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
  return { kind: "switched", delayMs, targetIdentity: candidateIdentity };
}

async function enumerateCandidates(
  op: Op,
  current: ExactDelegatedRuntimeDescriptor,
  attempted: ReadonlySet<string>,
): Promise<FailoverCandidate[]> {
  const out: FailoverCandidate[] = [];
  for (const provider of PROVIDER_IDS) {
    if (!providerAllowed(provider)) continue;
    const credential = await resolveCredential(provider, {
      configOpenAIKey: provider === "openai" ? getRuntimeConfig().openaiApiKey : undefined,
    });
    if (!credential) continue;
    for (const model of modelsFor(provider)) {
      try {
        const runtime = await resolveProviderRuntime(provider, model, {
          apiKey: credential.credential,
          authSource: credential.source,
          customBaseURL: getSetting<string>("customBaseUrl"),
        });
        if (runtime.identity.capabilitySnapshot?.contextWindowTokens === null) {
          const context = resolveContextWindow(model);
          if (context.provenance === "exact" || context.provenance === "probed") {
            runtime.identity.capabilitySnapshot.contextWindowTokens = context.tokens;
          }
        }
        let targetCredential = credential;
        if (runtime.identity.credentialProvider !== provider) {
          const resolved = await resolveCredential(runtime.identity.credentialProvider);
          if (!resolved || resolved.credential !== runtime.apiKey) continue;
          targetCredential = resolved;
        }
        const descriptor = sealDelegatedRuntime(op.id, {
          kind: "delegated-op",
          adapter: "provider-exact",
          ...runtime.identity,
          authSource: targetCredential.source,
          sessionId: current.sessionId,
          surface: current.surface,
        });
        if (attempted.has(runtimeTargetIdentity(descriptor))) continue;
        out.push({
          descriptor,
          certified: exactLocalCertification(descriptor),
        });
      } catch { /* unavailable candidates are normal */ }
    }
  }
  return out;
}

function modelsFor(provider: ProviderId): string[] {
  if (provider !== "local") {
    const model = PROVIDERS[provider].defaultModel;
    return model ? [model] : [];
  }
  return [...new Set((getLocalRuntimes() ?? []).flatMap(runtime => runtime.models.map(model => model.id)))].sort();
}

function exactLocalCertification(descriptor: ExactDelegatedRuntimeDescriptor): boolean {
  if (descriptor.target.kind !== "local-runtime") return descriptor.capabilitySnapshot?.locality !== "local";
  const runtimeId = descriptor.target.runtimeId;
  const runtime = (getLocalRuntimes() ?? []).find(item => item.id === runtimeId);
  const model = runtime?.models.find(item => item.id === descriptor.model);
  return !!runtime && !!model && hasPublishedCertification(runtime, model);
}

function providerAllowed(provider: ProviderId): boolean {
  if (!isLocalOnlyMode()) return true;
  return localProviderDecision(provider, getRuntimeConfig(), getSetting<string>("customBaseUrl")).allowed;
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
  currentIdentity: string,
  attempted: ReadonlySet<string>,
  normalized: string,
  retryAt: number,
): Promise<void> {
  const result = tryWithOpLock(op.id, () => {
    const fresh = readOp(op.id) ?? op;
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
