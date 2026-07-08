import { usesAnthropicSubscriptionAuth } from "../anthropic-models.js";
import { loadAnthropicTokens } from "../auth/anthropic.js";
import type { AnthropicTransport } from "./effective-window.js";

/**
 * Which Anthropic transport the next request will use, resolved from current
 * auth state.
 *
 * Mirrors getAnthropicApiKey()'s credential precedence (auth/anthropic.ts)
 * followed by streamAnthropicResponse()'s token-shape routing
 * (anthropic-client/stream.ts) — WITHOUT the async `claude --version` probe,
 * so it is cheap enough to call in the per-turn compaction hot path.
 *
 * Subscription-style credentials (the "cli" sentinel, an `oauth:` bearer, or
 * an `sk-ant-oat` token) route through the CLI subprocess proxy → "cli". A
 * real pay-as-you-go key (sk-ant-api03) routes to direct HTTP → "api".
 *
 * The result is model-independent: it only changes sizing for Anthropic
 * models (see effectiveContextWindow), so resolving it on a Codex/Gemini turn
 * is harmless. Not cached — a mid-session login must take effect immediately,
 * and the cost (one small file read) is negligible beside an LLM round-trip.
 *
 * CAUTION — parity is with getAnthropicApiKey, NOT resolveCredential. The
 * canonical Anthropic transport takes its token exclusively from
 * getAnthropicApiKey (adapters/anthropic-transport.ts), which never consults
 * the secrets store. auth-provider.ts's anthropicAuth().resolve() DOES fall
 * back to a store-held ANTHROPIC_API_KEY — a real key that would run direct
 * HTTP at the nominal window. If the canonical loop's Anthropic token source
 * ever moves to resolveCredential, this resolver must consult the store too,
 * or a store-only API key would be mis-sized as "cli" and compact early.
 */
export function resolveAnthropicTransport(): AnthropicTransport {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) return usesAnthropicSubscriptionAuth(envKey) ? "cli" : "api";
  if (process.env.ANTHROPIC_OAUTH_TOKEN) return "cli";

  try {
    // method:"token" → `oauth:` bearer; legacy oauth → "cli" sentinel. Either
    // token shape routes to the CLI proxy, so any saved token means "cli".
    if (loadAnthropicTokens()) return "cli";
  } catch {
    // loadAnthropicTokens already swallows parse errors to null; guard anyway
    // so a transient fs error can never throw out of a sizing call.
  }

  // No env key and no saved token: getAnthropicApiKey falls back to the
  // installed `claude` CLI's own credentials (the subprocess path). Default to
  // "cli" — the subscription window is the safe (smaller) assumption:
  // over-compacting is recoverable, under-compacting kills the op on a raw
  // "prompt is too long". If nothing is authenticated no request is made and
  // the value is moot.
  return "cli";
}
