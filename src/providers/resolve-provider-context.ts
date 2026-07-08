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
 *   - Resolves the provider chat EFFECTIVELY runs on: the user's explicitly-
 *     selected provider from settings.json when it has a usable credential,
 *     else the SAME credential-unavailable reroute the chat resolver applies
 *     (shared chain in credential-reroute.ts). The invariant is "classifiers
 *     run on the provider chat effectively runs on (post-reroute)" — never a
 *     cross-provider fan-out AWAY from the chat provider (that was the
 *     dark-mode-freeze bug; see classify-with-llm.ts), but also never a dead
 *     classifier fleet when chat itself has rerouted off a stale settings
 *     value (e.g. provider "codex" with no Codex credential while an
 *     Anthropic credential exists — chat self-healed, classifiers didn't).
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
import { getSecretsStoreSingleton } from "../secrets.js";
import { createLogger } from "../logger.js";
import { PROVIDER_IDS, type ProviderId } from "./provider-ids.js";
import { PROVIDERS } from "./registry.js";
import { rerouteToCredentialedProvider } from "./credential-reroute.js";

const logger = createLogger("providers.resolve-provider-context");

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

  if (apiKey) return { provider, apiKey, model };

  // Selected provider has no usable credential. Chat self-heals this class
  // via the shared reroute chain (credential-reroute.ts) — apply the same
  // chain here so classifiers resolve the provider chat EFFECTIVELY runs on
  // instead of silently dying on the raw settings value. Still returns null
  // when NO provider is credentialed.
  return resolveReroutedContext(provider);
}

async function resolveReroutedContext(selected: string): Promise<ProviderContext | null> {
  const store = getSecretsStoreSingleton();
  if (!store) return null; // can't probe credentials before the vault boots
  const requested: ProviderId | "" = isProviderId(selected) ? selected : "";
  const { provider: effective } = rerouteToCredentialedProvider(requested, (p) =>
    PROVIDERS[p].auth.hasCredential({ secretsStore: store }),
  );
  if (effective === selected) return null; // nothing new to try

  let apiKey = "";
  try {
    const r = await resolveCredential(effective);
    apiKey = r?.credential || "";
  } catch {
    /* fall through — no usable credential on the fallback either */
  }
  if (!apiKey) return null;
  logReroute(selected, effective);
  // The settings model belongs to the SELECTED provider — blank it so callers
  // apply the effective provider's own default (mirrors the chat reroute,
  // which drops the orphaned model the same way).
  return { provider: effective, apiKey, model: "" };
}

// Reroute logging: the chat path warns per resolve, but this seam fires on
// every classifier call — info ONCE per process per (from→to) pair, debug
// thereafter, so a dead settings provider doesn't spam the log.
const loggedReroutes = new Set<string>();
function logReroute(from: string, to: string): void {
  const key = `${from}→${to}`;
  const line =
    `provider switch: '${from}' unavailable (no usable credential) — ` +
    `classifier context rerouted to '${to}'.`;
  if (loggedReroutes.has(key)) {
    logger.debug(line);
    return;
  }
  loggedReroutes.add(key);
  logger.info(line);
}
