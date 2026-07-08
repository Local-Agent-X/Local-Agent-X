/**
 * Credential-unavailable reroute — the ONE implementation of "the requested
 * provider has no usable credential, pick a credentialed fallback instead".
 *
 * Extracted verbatim from the chat resolver (agent-request/resolve-provider.ts)
 * so the classifier context seam (providers/resolve-provider-context.ts) applies
 * the SAME fallback chain chat does. Before this, chat self-healed a stale
 * settings.json provider (e.g. "codex" with no Codex credential) while every
 * classifier resolved the raw settings value, failed credential resolution, and
 * silently died — compaction summarizer, end-of-turn memory extraction, curate
 * teach-moment all dead while chat looked healthy.
 *
 * Pure function: the credential probe is injected so each caller supplies its
 * own `hasCredential` context (chat has a request-scoped SecretsStore + config;
 * the classifier seam uses the process singletons).
 */
import type { ProviderId } from "./provider-ids.js";

export interface CredentialReroute {
  /** The effective provider — the requested one when it is credentialed. */
  provider: ProviderId;
  /** True when the requested provider was unusable (or empty) and the
   *  fallback chain chose instead. Note: with no credentials anywhere the
   *  chain still returns its default ("xai") with rerouted=true — callers
   *  that need a USABLE provider must still resolve its credential. */
  rerouted: boolean;
}

/**
 * Pick the effective provider for a request. When `requested` is credentialed
 * it is returned untouched; otherwise the fallback chain runs:
 *
 *   xAI (OAuth or API key) takes priority — Grok is the default on fresh
 *   installs and stays the default when the user has multiple providers
 *   configured but hasn't explicitly picked one in settings.json. Then
 *   Anthropic, then Codex (unless `allowCodexFallback` is false — the chat
 *   path disables it when a config-level OpenAI key is present). With no
 *   credentials anywhere, "xai" is returned so the picker shows Grok.
 */
export function rerouteToCredentialedProvider(
  requested: ProviderId | "",
  hasCredsFor: (p: ProviderId) => boolean,
  opts: { allowCodexFallback?: boolean } = {},
): CredentialReroute {
  if (requested && hasCredsFor(requested)) {
    return { provider: requested, rerouted: false };
  }
  let provider: ProviderId;
  if (hasCredsFor("xai")) provider = "xai";
  else if (hasCredsFor("anthropic")) provider = "anthropic";
  else if (hasCredsFor("codex") && (opts.allowCodexFallback ?? true)) provider = "codex";
  else provider = "xai"; // no creds anywhere → xai fallback so the picker shows Grok
  return { provider, rerouted: true };
}
