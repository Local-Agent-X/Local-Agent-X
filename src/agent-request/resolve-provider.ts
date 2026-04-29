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
  const VALID = ["codex", "xai", "openai", "anthropic", "local", "gemini", "custom"];
  const hasCredsFor = (p: string): boolean => {
    if (p === "anthropic") return !!loadAnthropicTokens();
    if (p === "codex") return !!loadTokens();
    if (p === "openai") return !!(config.openaiApiKey || secretsStore.get("OPENAI_API_KEY"));
    if (p === "xai") return !!secretsStore.get("XAI_API_KEY");
    if (p === "gemini") return !!secretsStore.get("GEMINI_API_KEY");
    if (p === "custom") return !!secretsStore.get("CUSTOM_API_KEY");
    if (p === "local") return true;
    return false;
  };
  // Caller-supplied override takes precedence if creds are available.
  // Lets a worker honor op.contextPack.routing.preferredProvider without
  // having to mutate settings.json.
  let provider = "";
  if (providerOverride && VALID.includes(providerOverride) && hasCredsFor(providerOverride)) {
    provider = providerOverride;
  } else {
    provider = String(saved.provider || "");
  }
  let providerWasOverridden = false;
  if (!VALID.includes(provider) || !hasCredsFor(provider)) {
    provider = loadAnthropicTokens() ? "anthropic" : (loadTokens() && !config.openaiApiKey) ? "codex" : "xai";
    providerWasOverridden = true;
  }
  // If we fell through to a different provider, the saved model almost
  // certainly belongs to the old one (e.g. settings.json says
  // openai/o3-pro, but no OpenAI key → fall through to anthropic, and
  // Anthropic has no idea what o3-pro is). Blank the saved model so the
  // downstream default picker chooses something valid for the new provider.
  if (providerWasOverridden) saved.model = "";

  // Resolve API key
  let apiKey: string;
  let codexApiKey: string | undefined;
  let customBaseURL: string | undefined;

  if (provider === "local") {
    apiKey = "ollama";
  } else if (provider === "anthropic") {
    apiKey = await getAnthropicApiKey();
    try { codexApiKey = await getApiKey(config.openaiApiKey); } catch {}
    if (!codexApiKey) codexApiKey = secretsStore.get("OPENAI_API_KEY") || undefined;
  } else if (provider === "xai") {
    apiKey = secretsStore.get("XAI_API_KEY") || "";
  } else if (provider === "gemini") {
    apiKey = secretsStore.get("GEMINI_API_KEY") || "";
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
     config.model);

  const temperature = typeof saved.temperature === "number" ? saved.temperature : config.temperature;
  const maxIterations = typeof saved.maxIterations === "number" ? saved.maxIterations : config.maxIterations;

  return { provider, apiKey, model, codexApiKey, customBaseURL, temperature, maxIterations };
}
