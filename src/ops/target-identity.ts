import type { DelegatedRuntimeTarget } from "./types.js";

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
