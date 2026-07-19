import type { TargetPin } from "../ops/types.js";
import type { AgentModelPin } from "../agents/types.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";

/** Preserve the caller's original explicit target, not its resolved fallback. */
export function explicitTargetPin(
  providerOverride: string | undefined,
  modelOverride: string | undefined,
): TargetPin | undefined {
  const provider = typeof providerOverride === "string"
    && (PROVIDER_IDS as readonly string[]).includes(providerOverride)
    ? providerOverride as ProviderId
    : undefined;
  const model = typeof modelOverride === "string" && modelOverride.trim()
    ? modelOverride
    : undefined;
  return provider || model
    ? { ...(provider ? { provider } : {}), ...(model ? { model } : {}) }
    : undefined;
}

export function targetPinForModelOverride(override: AgentModelPin | undefined): TargetPin | undefined {
  return override ? { provider: override.provider, model: override.model } : undefined;
}
