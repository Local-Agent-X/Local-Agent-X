import type { ProviderId } from "../providers/provider-ids.js";
import { PROVIDERS } from "../providers/registry.js";
import { getSecretsStoreSingleton } from "../secrets.js";
import type {
  CredentialResolution,
  ResolveCredentialOpts,
} from "./auth-provider.js";
import { isLocalOnlyMode } from "../local-only-policy.js";

export type { CredentialResolution } from "./auth-provider.js";

/**
 * Resolve a usable credential for `provider`, delegating to its registry
 * auth adapter (`meta.auth.resolve`). The per-provider precedence lives in
 * the adapter — see src/auth/auth-provider.ts.
 */
export async function resolveCredential(
  provider: ProviderId,
  opts?: ResolveCredentialOpts,
): Promise<CredentialResolution | null> {
  if (isLocalOnlyMode() && provider !== "local" && provider !== "custom") return null;
  const store = getSecretsStoreSingleton();
  return PROVIDERS[provider].auth.resolve(opts ?? {}, store);
}

/**
 * The key for a service that is not a chat provider (web search, speech to
 * text): the one saved in Settings → Secrets, else the environment variable of
 * the same name — the order the keyed providers use (auth-provider.ts
 * envKeyAuth). Reading only the environment ignored a key the user saved.
 */
export function resolveServiceKey(name: string): string | undefined {
  const saved = getSecretsStoreSingleton()?.get(name);
  if (saved) return saved;
  return process.env[name]?.trim() || undefined;
}
