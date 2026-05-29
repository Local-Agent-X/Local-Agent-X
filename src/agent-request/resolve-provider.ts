import type { LAXConfig } from "../types.js";
import type { SecretsStore } from "../secrets.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";
import { PROVIDERS, isHttpProvider } from "../providers/registry.js";
import { loadSettings, getSetting } from "../settings.js";
import { resolveCredential } from "../auth/resolve.js";

const isProviderId = (s: string): s is ProviderId =>
  (PROVIDER_IDS as readonly string[]).includes(s);

export async function resolveProvider(
  config: LAXConfig,
  secretsStore: SecretsStore,
  dataDir: string,
  /** Optional override — forces this provider id if creds are available;
   *  falls through to the normal auto-detect chain otherwise. */
  providerOverride?: string,
  /** Optional model override. Takes precedence over `saved.model` and the
   *  provider registry default. Only honored when non-empty. */
  modelOverride?: string,
): Promise<{
  provider: string;
  apiKey: string;
  model: string;
  codexApiKey?: string;
  customBaseURL?: string;
  temperature: number;
  maxIterations: number;
}> {
  // Load saved settings (spread because the codepath blanks saved.model below)
  const saved: Record<string, unknown> = { ...loadSettings() };

  // Resolve provider. If a saved provider exists but has no usable credentials,
  // fall through to auto-detection so a stale "codex" default from a previous
  // run doesn't block a freshly-signed-in Anthropic user. Each provider's
  // auth adapter owns the per-provider presence check.
  const hasCredsFor = (p: ProviderId): boolean =>
    PROVIDERS[p].auth.hasCredential({ secretsStore, configOpenAIKey: config.openaiApiKey });
  // Caller-supplied override takes precedence if creds are available.
  // Lets a worker honor op.contextPack.routing.preferredProvider without
  // having to mutate settings.json.
  let provider: ProviderId | "" = "";
  let providerWasOverridden = false;
  const savedProvider = String(saved.provider || "");
  if (providerOverride && isProviderId(providerOverride) && hasCredsFor(providerOverride)) {
    provider = providerOverride;
    // If the caller-supplied override differs from the saved provider, the
    // saved model belongs to the old provider (e.g. settings.json says
    // codex/gpt-5.5, override forces anthropic, but saved model is still
    // gpt-5.5 — Claude has no idea what that is). Blank it so the
    // downstream default picker chooses a valid model for the new provider.
    if (providerOverride !== savedProvider) providerWasOverridden = true;
  } else if (isProviderId(savedProvider)) {
    provider = savedProvider;
  }
  if (!provider || !hasCredsFor(provider)) {
    // xAI (OAuth or API key) takes priority — Grok is the default on fresh
    // installs and stays the default when the user has multiple providers
    // configured but hasn't explicitly picked one in settings.json.
    if (hasCredsFor("xai")) provider = "xai";
    else if (hasCredsFor("anthropic")) provider = "anthropic";
    else if (hasCredsFor("codex") && !config.openaiApiKey) provider = "codex";
    else provider = "xai"; // no creds anywhere → xai fallback so the picker shows Grok
    providerWasOverridden = true;
  }
  // If we fell through to a different provider OR the caller-override forced
  // a switch, the saved model almost certainly belongs to the old provider.
  // Blank it so the downstream default picker picks something valid.
  if (providerWasOverridden) saved.model = "";

  // Resolve API key
  let apiKey: string;
  let codexApiKey: string | undefined;
  let customBaseURL: string | undefined;

  const meta = PROVIDERS[provider];
  const r = await resolveCredential(provider, { configOpenAIKey: config.openaiApiKey });
  apiKey = r?.credential ?? "";

  if (!isHttpProvider(meta)) {
    // Anthropic (CLI transport) also carries a Codex side-key so build_app
    // can route through the Codex CLI even when the main provider is Claude.
    const cr = await resolveCredential("codex", { configOpenAIKey: config.openaiApiKey });
    codexApiKey = cr?.credential || undefined;
    if (!codexApiKey) codexApiKey = secretsStore.get("OPENAI_API_KEY") || undefined;
  } else if (provider === "custom") {
    customBaseURL = getSetting<string>("customBaseUrl") || undefined;
  }

  // Default model — registry is SoT. Falls back to config.model when
  // the registry leaves defaultModel empty (e.g., ollama-cloud where
  // the user picks from the cloud catalog). Caller-supplied modelOverride
  // wins when non-empty (per-job cron model selection).
  const model = (modelOverride && modelOverride.trim())
    || String(saved.model || "")
    || meta.defaultModel
    || config.model;

  const temperature = typeof saved.temperature === "number" ? saved.temperature : config.temperature;
  const maxIterations = typeof saved.maxIterations === "number" ? saved.maxIterations : config.maxIterations;

  return { provider, apiKey, model, codexApiKey, customBaseURL, temperature, maxIterations };
}
