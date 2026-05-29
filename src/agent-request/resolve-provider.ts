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
  const { loadTokens } = await import("../auth/index.js");
  const { loadAnthropicTokens } = await import("../auth/anthropic.js");
  const { loadXaiTokens } = await import("../auth/xai.js");

  // Load saved settings (spread because the codepath blanks saved.model below)
  const saved: Record<string, unknown> = { ...loadSettings() };

  // Resolve provider. If a saved provider exists but has no usable credentials,
  // fall through to auto-detection so a stale "codex" default from a previous
  // run doesn't block a freshly-signed-in Anthropic user.
  const hasCredsFor = (p: ProviderId): boolean => {
    const meta = PROVIDERS[p];
    // CLI transport (anthropic): trust the auth-anthropic token check.
    if (!isHttpProvider(meta)) return !!loadAnthropicTokens();
    // Codex uses ChatGPT OAuth, not a SecretsStore key.
    if (p === "codex") return !!loadTokens();
    // OpenAI accepts either a config-level key or the SecretsStore.
    if (p === "openai") return !!(config.openaiApiKey || secretsStore.get(meta.envKey));
    // xAI accepts either OAuth (SuperGrok / X Premium+) or an API key.
    if (p === "xai") return !!(loadXaiTokens() || secretsStore.get(meta.envKey));
    // Local Ollama needs no key.
    if (meta.envKey === "") return true;
    return !!secretsStore.get(meta.envKey);
  };
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
    if (loadXaiTokens() || secretsStore.get("XAI_API_KEY")) provider = "xai";
    else if (loadAnthropicTokens()) provider = "anthropic";
    else if (loadTokens() && !config.openaiApiKey) provider = "codex";
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
  if (!isHttpProvider(meta)) {
    // CLI transport: anthropic via Claude CLI subprocess.
    const r = await resolveCredential("anthropic");
    apiKey = r?.credential ?? "";
    const cr = await resolveCredential("codex", { configOpenAIKey: config.openaiApiKey });
    codexApiKey = cr?.credential || undefined;
    if (!codexApiKey) codexApiKey = secretsStore.get("OPENAI_API_KEY") || undefined;
  } else if (provider === "local") {
    apiKey = "ollama";
  } else if (provider === "codex") {
    const r = await resolveCredential("codex", { configOpenAIKey: config.openaiApiKey });
    apiKey = r?.credential ?? "";
  } else if (provider === "openai") {
    const r = await resolveCredential("openai", { configOpenAIKey: config.openaiApiKey });
    apiKey = r?.credential ?? "";
  } else if (provider === "xai") {
    const r = await resolveCredential("xai");
    apiKey = r?.credential ?? "";
  } else if (provider === "custom") {
    const r = await resolveCredential("custom");
    apiKey = r?.credential ?? "";
    customBaseURL = getSetting<string>("customBaseUrl") || undefined;
  } else {
    const r = await resolveCredential(provider);
    apiKey = r?.credential ?? "";
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
