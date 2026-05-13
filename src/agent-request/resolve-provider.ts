import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LAXConfig } from "../types.js";
import type { SecretsStore } from "../secrets.js";
import { getApiKey } from "../auth.js";

export async function resolveProvider(
  config: LAXConfig,
  secretsStore: SecretsStore,
  dataDir: string,
  /** Optional override — forces this provider id if creds are available;
   *  falls through to the normal auto-detect chain otherwise. */
  providerOverride?: string,
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

  // Load saved settings
  let saved: Record<string, unknown> = {};
  try {
    const sp = join(dataDir, "settings.json");
    if (existsSync(sp)) saved = JSON.parse(readFileSync(sp, "utf-8"));
  } catch {}

  // Resolve provider. If a saved provider exists but has no usable credentials,
  // fall through to auto-detection so a stale "codex" default from a previous
  // run doesn't block a freshly-signed-in Anthropic user.
  const VALID = ["codex", "xai", "openai", "anthropic", "local", "ollama-cloud", "gemini", "cerebras", "custom"];
  const hasCredsFor = (p: string): boolean => {
    if (p === "anthropic") return !!loadAnthropicTokens();
    if (p === "codex") return !!loadTokens();
    if (p === "openai") return !!(config.openaiApiKey || secretsStore.get("OPENAI_API_KEY"));
    if (p === "xai") return !!secretsStore.get("XAI_API_KEY");
    if (p === "gemini") return !!secretsStore.get("GEMINI_API_KEY");
    if (p === "cerebras") return !!secretsStore.get("CEREBRAS_API_KEY");
    if (p === "custom") return !!secretsStore.get("CUSTOM_API_KEY");
    if (p === "ollama-cloud") return !!secretsStore.get("OLLAMA_CLOUD_API_KEY");
    if (p === "local") return true;
    return false;
  };
  // Caller-supplied override takes precedence if creds are available.
  // Lets a worker honor op.contextPack.routing.preferredProvider without
  // having to mutate settings.json.
  let provider = "";
  let providerWasOverridden = false;
  const savedProvider = String(saved.provider || "");
  if (providerOverride && VALID.includes(providerOverride) && hasCredsFor(providerOverride)) {
    provider = providerOverride;
    // If the caller-supplied override differs from the saved provider, the
    // saved model belongs to the old provider (e.g. settings.json says
    // codex/gpt-5.5, override forces anthropic, but saved model is still
    // gpt-5.5 — Claude has no idea what that is). Blank it so the
    // downstream default picker chooses a valid model for the new provider.
    if (providerOverride !== savedProvider) providerWasOverridden = true;
  } else {
    provider = savedProvider;
  }
  if (!VALID.includes(provider) || !hasCredsFor(provider)) {
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

  if (provider === "local") {
    apiKey = "ollama";
  } else if (provider === "ollama-cloud") {
    // Ollama Turbo (cloud) uses the same canonical adapter as local; the
    // chat-runner detects this provider and routes to the cloud baseURL
    // with the cloud API key. resolveProvider just surfaces the key.
    apiKey = secretsStore.get("OLLAMA_CLOUD_API_KEY") || "";
  } else if (provider === "anthropic") {
    apiKey = await getAnthropicApiKey();
    try { codexApiKey = await getApiKey(config.openaiApiKey); } catch {}
    if (!codexApiKey) codexApiKey = secretsStore.get("OPENAI_API_KEY") || undefined;
  } else if (provider === "xai") {
    apiKey = secretsStore.get("XAI_API_KEY") || "";
  } else if (provider === "gemini") {
    apiKey = secretsStore.get("GEMINI_API_KEY") || "";
  } else if (provider === "cerebras") {
    apiKey = secretsStore.get("CEREBRAS_API_KEY") || "";
  } else if (provider === "custom") {
    apiKey = secretsStore.get("CUSTOM_API_KEY") || "";
    try {
      const sp = join(dataDir, "settings.json");
      if (existsSync(sp)) {
        const ss = JSON.parse(readFileSync(sp, "utf-8"));
        customBaseURL = ss.customBaseUrl || undefined;
      }
    } catch {}
  } else if (provider === "openai" && !config.openaiApiKey) {
    apiKey = secretsStore.get("OPENAI_API_KEY") || await getApiKey(config.openaiApiKey);
  } else {
    apiKey = await getApiKey(config.openaiApiKey);
  }

  const model = String(saved.model || "") ||
    (provider === "codex" ? "gpt-5.4-mini" :
     provider === "anthropic" ? "claude-sonnet-4-6" :
     provider === "gemini" ? "gemini-2.0-flash" :
     provider === "cerebras" ? "llama-3.3-70b" :
     config.model);

  const temperature = typeof saved.temperature === "number" ? saved.temperature : config.temperature;
  const maxIterations = typeof saved.maxIterations === "number" ? saved.maxIterations : config.maxIterations;

  return { provider, apiKey, model, codexApiKey, customBaseURL, temperature, maxIterations };
}
