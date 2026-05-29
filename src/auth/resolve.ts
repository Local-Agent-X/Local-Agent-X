import type { ProviderId } from "../providers/provider-ids.js";
import { PROVIDERS, isHttpProvider } from "../providers/registry.js";
import { getSecretsStoreSingleton } from "../secrets.js";
import { createLogger } from "../logger.js";

const logger = createLogger("auth.resolve");

function envKeyFor(provider: ProviderId): string {
  const meta = PROVIDERS[provider];
  return isHttpProvider(meta) ? meta.envKey : "";
}

export interface CredentialResolution {
  provider: ProviderId;
  credential: string;
  source: "oauth" | "env" | "secrets-store" | "config" | "sentinel";
}

export async function resolveCredential(
  provider: ProviderId,
  opts?: {
    rejectOAuth?: boolean;
    configOpenAIKey?: string;
  },
): Promise<CredentialResolution | null> {
  const rejectOAuth = opts?.rejectOAuth === true;
  const configOpenAIKey = opts?.configOpenAIKey;
  const store = getSecretsStoreSingleton();

  if (provider === "local" || (provider as string) === "ollama") {
    return { provider, credential: "ollama", source: "sentinel" };
  }

  if (provider === "anthropic") {
    try {
      const { getAnthropicApiKey } = await import("./anthropic.js");
      const oauth = await getAnthropicApiKey();
      if (oauth) {
        const isOAuth = oauth.startsWith("oauth:");
        if (!(rejectOAuth && isOAuth)) {
          return { provider, credential: oauth, source: "oauth" };
        }
      }
    } catch { /* fall through to secrets/env */ }
    const envKey = "ANTHROPIC_API_KEY";
    const fromStore = store?.get(envKey);
    if (fromStore) return { provider, credential: fromStore, source: "secrets-store" };
    const fromEnv = process.env[envKey];
    if (fromEnv) return { provider, credential: fromEnv, source: "env" };
    logger.warn(`no credential found for provider "${provider}"`);
    return null;
  }

  if (provider === "codex") {
    try {
      const { getApiKey } = await import("./index.js");
      const key = await getApiKey(configOpenAIKey);
      if (key) return { provider, credential: key, source: "oauth" };
    } catch { /* fall through */ }
    logger.warn(`no credential found for provider "${provider}"`);
    return null;
  }

  if (provider === "xai") {
    try {
      const { getXaiApiKey } = await import("./xai.js");
      const oauth = await getXaiApiKey();
      if (oauth) {
        if (!rejectOAuth) {
          return { provider, credential: oauth, source: "oauth" };
        }
      }
    } catch { /* fall through */ }
    const envKey = envKeyFor("xai");
    const fromStore = store?.get(envKey);
    if (fromStore) return { provider, credential: fromStore, source: "secrets-store" };
    const fromEnv = process.env[envKey];
    if (fromEnv) return { provider, credential: fromEnv, source: "env" };
    logger.warn(`no credential found for provider "${provider}"`);
    return null;
  }

  if (provider === "openai") {
    if (configOpenAIKey) return { provider, credential: configOpenAIKey, source: "config" };
    const envKey = envKeyFor("openai");
    const fromStore = store?.get(envKey);
    if (fromStore) return { provider, credential: fromStore, source: "secrets-store" };
    const fromEnv = process.env[envKey];
    if (fromEnv) return { provider, credential: fromEnv, source: "env" };
    logger.warn(`no credential found for provider "${provider}"`);
    return null;
  }

  if (provider === "custom") {
    const envKey = envKeyFor("custom");
    const fromStore = store?.get(envKey);
    if (fromStore) return { provider, credential: fromStore, source: "secrets-store" };
    logger.warn(`no credential found for provider "${provider}"`);
    return null;
  }

  if (provider === "gemini" || provider === "cerebras" || provider === "ollama-cloud") {
    const envKey = envKeyFor(provider);
    const fromStore = store?.get(envKey);
    if (fromStore) return { provider, credential: fromStore, source: "secrets-store" };
    const fromEnv = process.env[envKey];
    if (fromEnv) return { provider, credential: fromEnv, source: "env" };
    logger.warn(`no credential found for provider "${provider}"`);
    return null;
  }

  const exhaustive: never = provider;
  throw new Error(`resolveCredential: unknown provider "${exhaustive as string}"`);
}
