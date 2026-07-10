/**
 * Shared embedding-provider accessor.
 *
 * The memory subsystem builds a provider once at boot (bootstrap-services.ts).
 * Other modules that need embeddings (protocol dedup, future similar features)
 * shouldn't re-construct one — both because it doubles the warmup cost and
 * because the user's configured choice (Ollama / OpenAI / Voyage / etc.) lives
 * in settings.json and we want a single source of truth.
 *
 * Mirrors the setRuntimeConfig/getRuntimeConfig pattern.
 */
import type { ExtendedEmbeddingProvider } from "./embedding-providers/types.js";
import { isLocalOnlyMode } from "./local-only-policy.js";

let _provider: ExtendedEmbeddingProvider | null = null;

export function setEmbeddingProviderSingleton(provider: ExtendedEmbeddingProvider): void {
  _provider = provider;
}

/** Returns the configured embedding provider, or null if memory init hasn't
 *  run yet / it's degraded. Callers MUST handle null (it's a soft dependency:
 *  protocol dedup degrades to "no dedup" without throwing). */
export function getEmbeddingProviderSingleton(): ExtendedEmbeddingProvider | null {
  if (isLocalOnlyMode() && _provider?.name !== "local" && _provider?.name !== "ollama") return null;
  return _provider;
}
