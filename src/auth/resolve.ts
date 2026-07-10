import type { ProviderId } from "../providers/provider-ids.js";
import { PROVIDERS } from "../providers/registry.js";
import { getSecretsStoreSingleton } from "../secrets.js";
import { isStrictLocalOnly } from "../security/egress-policy.js";
import type {
  CredentialResolution,
  ResolveCredentialOpts,
} from "./auth-provider.js";

export type { CredentialResolution } from "./auth-provider.js";

/**
 * Providers that stay usable under strictLocalOnly — the keyless local Ollama
 * transport only. Everything else (including "custom", whose base URL is not
 * verifiably local, and "ollama-cloud") resolves a CLOUD credential and is
 * refused while the flag is on. Fail closed.
 */
const LOCAL_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["local"]);

/**
 * Throws when `provider` is a cloud provider and strictLocalOnly (config.json)
 * is enabled. This runs inside resolveCredential — the single credential seam
 * every cloud turn flows through (llm-dispatch, agent-request/resolve-provider,
 * providers/resolve-provider-context, image tools, reranker, video-summary) —
 * so cloud resolution refuses in ONE place instead of per-transport checks.
 */
export function assertAllowedByStrictLocalOnly(provider: ProviderId): void {
  if (LOCAL_PROVIDERS.has(provider)) return;
  if (!isStrictLocalOnly()) return;
  throw new Error(
    `Provider "${provider}" is blocked: strictLocalOnly is enabled in config.json — ` +
    `cloud LLM providers are unavailable. Use the local (Ollama) provider or disable strictLocalOnly.`,
  );
}

/**
 * Resolve a usable credential for `provider`, delegating to its registry
 * auth adapter (`meta.auth.resolve`). The per-provider precedence lives in
 * the adapter — see src/auth/auth-provider.ts. Refuses (throws) for cloud
 * providers while strictLocalOnly is enabled.
 */
export async function resolveCredential(
  provider: ProviderId,
  opts?: ResolveCredentialOpts,
): Promise<CredentialResolution | null> {
  assertAllowedByStrictLocalOnly(provider);
  const store = getSecretsStoreSingleton();
  return PROVIDERS[provider].auth.resolve(opts ?? {}, store);
}
