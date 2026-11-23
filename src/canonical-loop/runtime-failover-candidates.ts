/**
 * Which runtimes could take over a delegated op whose runtime failed: every
 * provider this machine has a credential for (only the local ones in
 * local-only mode), at its default model, and every model a local runtime
 * serves, each sealed as the exact runtime it would be, minus the ones this
 * op has already tried. runtime-failover.ts decides which of them, if any,
 * the op moves to.
 */
import { resolveCredential } from "../auth/resolve.js";
import { getRuntimeConfig } from "../config.js";
import { resolveContextWindow } from "../context-manager/model-windows.js";
import { isLocalOnlyMode, localProviderDecision } from "../local-only-policy.js";
import { getLocalRuntimes, hasPublishedCertification } from "../local-runtimes/index.js";
import { runtimeTargetIdentity } from "../ops/target-identity.js";
import type { ExactDelegatedRuntimeDescriptor, Op } from "../ops/types.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";
import { PROVIDERS } from "../providers/registry.js";
import { getSetting } from "../settings.js";
import { resolveProviderRuntime } from "./provider-adapter-factory.js";
import { sealDelegatedRuntime } from "./runtime-integrity.js";

export interface FailoverCandidate {
  descriptor: ExactDelegatedRuntimeDescriptor;
  certified: boolean;
}

export async function enumerateFailoverCandidates(
  op: Op,
  current: ExactDelegatedRuntimeDescriptor,
  attempted: ReadonlySet<string>,
): Promise<FailoverCandidate[]> {
  const out: FailoverCandidate[] = [];
  for (const provider of PROVIDER_IDS) {
    if (!failoverProviderAllowed(provider)) continue;
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

export function exactLocalCertification(descriptor: ExactDelegatedRuntimeDescriptor): boolean {
  if (descriptor.target.kind !== "local-runtime") return descriptor.capabilitySnapshot?.locality !== "local";
  const runtimeId = descriptor.target.runtimeId;
  const runtime = (getLocalRuntimes() ?? []).find(item => item.id === runtimeId);
  const model = runtime?.models.find(item => item.id === descriptor.model);
  return !!runtime && !!model && hasPublishedCertification(runtime, model);
}

export function failoverProviderAllowed(provider: ProviderId): boolean {
  if (!isLocalOnlyMode()) return true;
  return localProviderDecision(provider, getRuntimeConfig(), getSetting<string>("customBaseUrl")).allowed;
}
