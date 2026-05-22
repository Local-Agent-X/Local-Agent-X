import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LAXConfig } from "../types.js";
import type { SecretsStore } from "../secrets.js";
import { getApiKey } from "../auth.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";
import { PROVIDERS, isHttpProvider } from "../providers/registry.js";

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
  const { loadTokens } = await import("../auth.js");
  const { loadAnthropicTokens, getAnthropicApiKey } = await import("../auth-anthropic.js");
  const { loadXaiTokens, getXaiApiKey } = await import("../auth-xai.js");

  // Load saved settings
  let saved: Record<string, unknown> = {};
  try {
    const sp = join(dataDir, "settings.json");
    if (existsSync(sp)) saved = JSON.parse(readFileSync(sp, "utf-8"));
  } catch {}

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
    provider = loadAnthropicTokens() ? "anthropic" : (loadTokens() && !config.openaiApiKey) ? "codex" : "xai";
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
    apiKey = await getAnthropicApiKey();
    try { codexApiKey = await getApiKey(config.openaiApiKey); } catch {}
    if (!codexApiKey) codexApiKey = secretsStore.get("OPENAI_API_KEY") || undefined;
  } else if (provider === "local") {
    apiKey = "ollama";
  } else if (provider === "codex") {
    // Codex uses ChatGPT OAuth, not the openai envKey.
    apiKey = await getApiKey(config.openaiApiKey);
  } else if (provider === "openai") {
    apiKey = config.openaiApiKey || secretsStore.get(meta.envKey) || await getApiKey(config.openaiApiKey);
  } else if (provider === "xai") {
    // Prefer OAuth bearer (SuperGrok / X Premium+) when present, fall back
    // to XAI_API_KEY. Bearer + key are wire-identical on api.x.ai/v1, so
    // openai-http consumes either without branching.
    const oauth = await getXaiApiKey();
    apiKey = oauth || secretsStore.get(meta.envKey) || "";
  } else if (provider === "custom") {
    apiKey = secretsStore.get(meta.envKey) || "";
    try {
      const sp = join(dataDir, "settings.json");
      if (existsSync(sp)) {
        const ss = JSON.parse(readFileSync(sp, "utf-8"));
        customBaseURL = ss.customBaseUrl || undefined;
      }
    } catch {}
  } else {
    // Generic http provider — xai, gemini, cerebras, ollama-cloud.
    apiKey = secretsStore.get(meta.envKey) || "";
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
