import type { ProviderId } from "../providers/provider-ids.js";
import { PROVIDERS } from "../providers/registry.js";
import { getSecretsStoreSingleton } from "../secrets.js";
import type {
  CredentialResolution,
  ResolveCredentialOpts,
} from "./auth-provider.js";

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
  const store = getSecretsStoreSingleton();
  return PROVIDERS[provider].auth.resolve(opts ?? {}, store);
}
