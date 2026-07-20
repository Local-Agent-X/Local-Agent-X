import type { DelegatedRuntimeTarget, ExactDelegatedRuntimeDescriptor, Op } from "./types.js";

/** Stable, content-free identity for binding persisted facts to one exact target. */
export function runtimeTargetIdentity(identity: {
  provider: string;
  model: string;
  target: DelegatedRuntimeTarget;
}): string {
  const { provider, model, target } = identity;
  return JSON.stringify(target.kind === "local-runtime"
    ? [provider, model, target.kind, target.runtimeId, target.endpointFingerprint]
    : [provider, model, target.kind, target.endpointFingerprint]);
}

/** True only for a complete durable boundary whose signed descriptor matches
 * the exact candidate identity. Used to discard old provider-native state. */
export function isRuntimeFailoverBoundary(
  op: Op,
  descriptor: ExactDelegatedRuntimeDescriptor,
): boolean {
  const state = op.canonical?.runtimeFailover;
  if (!state || state.schemaVersion !== 1) return false;
  if (state.phase !== "cooldown" && state.phase !== "waiting") return false;
  const identity = runtimeTargetIdentity(descriptor);
  return state.currentTargetIdentity === identity
    && (state.candidateTargetIdentity === null || state.candidateTargetIdentity === identity)
    && state.attemptedTargetIdentities.includes(identity)
    && Number.isFinite(Date.parse(state.retryNotBefore))
    && Number.isInteger(state.revision) && state.revision > 0;
}
