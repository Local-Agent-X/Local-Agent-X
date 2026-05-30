/**
 * resolveProviderContext — resolve the user's currently-selected provider and
 * its credential for lightweight, non-chat callers (LLM-as-classifier calls,
 * one-shot dispatches) that need the SAME provider/auth the chat path uses but
 * NOT the full canonical-loop turn machinery.
 *
 * This is the consolidation point the provider registry header tracks: the
 * "settings → credential" half of provider resolution used to be hand-rolled
 * in classifiers/classify-with-llm.ts as a 6-way `if/else` over resolveCredential.
 * The chat seam (agent-request/resolve-provider.ts) already reads provider
 * metadata + credentials through the registry + the auth seam; this helper
 * gives the classifier path the same single source of truth without dragging
 * the chat resolver's auto-detect / override / codex-side-key logic (which is
 * specific to full agent turns) into a throwaway classification call.
 *
 * Scope, deliberately narrow:
 *   - Reads ONLY the user's explicitly-selected provider from settings.json.
 *     No auto-detect fallback across providers — a classifier must run on the
 *     same provider the user is chatting on, never silently fan out to
 *     Anthropic on a Codex turn (that was the dark-mode-freeze bug; see
 *     classify-with-llm.ts).
 *   - Resolves the credential through the canonical `resolveCredential` auth
 *     seam, so OAuth / env / SecretsStore quirks live in one place.
 *   - Does NOT decide a default model. Model selection is caller policy:
 *     chat wants the capable registry default; classifiers want a cheaper
 *     floor, and `dispatch()` self-defaults the OpenAI-compat providers. The
 *     caller layers its own model choice on top of `model` (the user's
 *     configured model, or "" when unset).
 *
 * ADR-0001: this module intentionally has NO dependency on retry-context.ts /
 * retry-telemetry.ts — it is pure settings + auth resolution.
 */
import { loadSettings } from "../settings.js";
import { resolveCredential } from "../auth/resolve.js";
import { PROVIDER_IDS, type ProviderId } from "./provider-ids.js";

export interface ProviderContext {
  /** Lower-cased provider id from settings.json (e.g. "anthropic", "codex"). */
  provider: string;
  /** Resolved credential / token for the provider. Never empty — null is
   *  returned instead when no usable credential exists. */
  apiKey: string;
  /** The user's configured model from settings.json, or "" when unset.
   *  Callers apply their own default policy on top of this. */
  model: string;
}

const isProviderId = (s: string): s is ProviderId =>
  (PROVIDER_IDS as readonly string[]).includes(s);

/**
 * Resolve {provider, apiKey, model} for the user's currently-selected
 * provider. Returns null when no usable credential is configured — callers
 * treat that as "no provider available" and fall back (regex/heuristic for
 * classifiers). Re-reads settings on every call so a provider switch in the
 * UI takes effect on the next invocation.
 */
export async function resolveProviderContext(): Promise<ProviderContext | null> {
  let provider = "anthropic";
  let model = "";
  const s = loadSettings() as { provider?: string; model?: string };
  if (s.provider) provider = String(s.provider).toLowerCase();
  if (s.model) model = String(s.model);

  let apiKey = "";
  try {
    if (provider === "ollama" || provider === "local") {
      // Local Ollama needs no real credential — the OpenAI-compat client
      // only requires a non-empty placeholder. Matches the chat path's
      // treatment of local transports.
      apiKey = "ollama";
    } else if (isProviderId(provider)) {
      const r = await resolveCredential(provider);
      apiKey = r?.credential || "";
    }
    // Unknown provider strings fall through with apiKey "" → null below.
  } catch {
    /* fall through to the no-credential return below */
  }

  if (!apiKey) return null;
  return { provider, apiKey, model };
}
