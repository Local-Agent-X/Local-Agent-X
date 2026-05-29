/**
 * AuthProvider port — credential resolution as a per-provider seam.
 *
 * Each provider in the PROVIDERS registry carries one of these adapters on
 * `meta.auth`. Callers ask the registry (`meta.auth.resolve()` /
 * `meta.auth.hasCredential()`) instead of branching on the provider id, so
 * adding a provider means registering its adapter — not editing a switch in
 * resolve.ts and resolve-provider.ts in lockstep.
 *
 * The adapters here only WRAP the existing loaders in auth/index, auth/anthropic
 * and auth/xai — the OAuth/PKCE logic is unchanged, just put behind the port.
 *
 * Precedence subtleties preserved verbatim from the old switch:
 *   - `resolve()` falls back to process.env; `hasCredential()` never does. A
 *     user with only GEMINI_API_KEY in the environment (not the secrets store)
 *     resolves fine but won't be auto-detected — same as before this refactor.
 *   - `custom` resolves from the secrets store ONLY (no env fallback).
 *   - anthropic OAuth XOR api-key, with rejectOAuth honored; xai OAuth XOR env.
 */
import type { ProviderId } from "../providers/provider-ids.js";
import type { SecretsStore } from "../secrets.js";
import { createLogger } from "../logger.js";
import { getAnthropicApiKey, loadAnthropicTokens } from "./anthropic.js";
import { getApiKey, loadTokens } from "./index.js";
import { getXaiApiKey, loadXaiTokens } from "./xai.js";

const logger = createLogger("auth.resolve");

export type CredentialSource =
  | "oauth"
  | "env"
  | "secrets-store"
  | "config"
  | "sentinel";

export interface CredentialResolution {
  provider: ProviderId;
  credential: string;
  source: CredentialSource;
}

export interface ResolveCredentialOpts {
  rejectOAuth?: boolean;
  configOpenAIKey?: string;
}

/** Context for the sync, login-time credential presence check. */
export interface HasCredentialCtx {
  secretsStore: SecretsStore;
  configOpenAIKey?: string;
}

/**
 * Per-provider credential adapter.
 *
 * `resolve` is the async path used at request time — secrets MUST NOT be
 * logged or returned anywhere but in the `credential` field. `hasCredential`
 * is the cheap sync probe used by provider auto-detection; it must not touch
 * the network.
 */
export interface AuthProvider {
  resolve(
    opts: ResolveCredentialOpts,
    store: SecretsStore | null,
  ): Promise<CredentialResolution | null>;
  hasCredential(ctx: HasCredentialCtx): boolean;
}

function warnMissing(provider: ProviderId): null {
  logger.warn(`no credential found for provider "${provider}"`);
  return null;
}

/** Anthropic: OAuth (Claude CLI / subscription) XOR ANTHROPIC_API_KEY. */
function anthropicAuth(): AuthProvider {
  const id: ProviderId = "anthropic";
  const ENV_KEY = "ANTHROPIC_API_KEY";
  return {
    async resolve(opts, store) {
      const rejectOAuth = opts.rejectOAuth === true;
      try {
        const oauth = await getAnthropicApiKey();
        if (oauth) {
          const isOAuth = oauth.startsWith("oauth:");
          if (!(rejectOAuth && isOAuth)) {
            return { provider: id, credential: oauth, source: "oauth" };
          }
        }
      } catch { /* fall through to secrets/env */ }
      const fromStore = store?.get(ENV_KEY);
      if (fromStore) return { provider: id, credential: fromStore, source: "secrets-store" };
      const fromEnv = process.env[ENV_KEY];
      if (fromEnv) return { provider: id, credential: fromEnv, source: "env" };
      return warnMissing(id);
    },
    hasCredential() {
      return !!loadAnthropicTokens();
    },
  };
}

/** Codex: ChatGPT OAuth (config key takes priority inside getApiKey). */
function codexAuth(): AuthProvider {
  const id: ProviderId = "codex";
  return {
    async resolve(opts) {
      try {
        const key = await getApiKey(opts.configOpenAIKey);
        if (key) return { provider: id, credential: key, source: "oauth" };
      } catch { /* fall through */ }
      return warnMissing(id);
    },
    hasCredential() {
      return !!loadTokens();
    },
  };
}

/** xAI: SuperGrok/Premium+ OAuth XOR XAI_API_KEY (store then env). */
function xaiAuth(envKey: string): AuthProvider {
  const id: ProviderId = "xai";
  return {
    async resolve(opts, store) {
      const rejectOAuth = opts.rejectOAuth === true;
      try {
        const oauth = await getXaiApiKey();
        if (oauth && !rejectOAuth) {
          return { provider: id, credential: oauth, source: "oauth" };
        }
      } catch { /* fall through */ }
      const fromStore = store?.get(envKey);
      if (fromStore) return { provider: id, credential: fromStore, source: "secrets-store" };
      const fromEnv = process.env[envKey];
      if (fromEnv) return { provider: id, credential: fromEnv, source: "env" };
      return warnMissing(id);
    },
    hasCredential(ctx) {
      return !!(loadXaiTokens() || ctx.secretsStore.get(envKey));
    },
  };
}

/** OpenAI: config key → secrets store → env var. */
function openaiAuth(envKey: string): AuthProvider {
  const id: ProviderId = "openai";
  return {
    async resolve(opts, store) {
      if (opts.configOpenAIKey) {
        return { provider: id, credential: opts.configOpenAIKey, source: "config" };
      }
      const fromStore = store?.get(envKey);
      if (fromStore) return { provider: id, credential: fromStore, source: "secrets-store" };
      const fromEnv = process.env[envKey];
      if (fromEnv) return { provider: id, credential: fromEnv, source: "env" };
      return warnMissing(id);
    },
    hasCredential(ctx) {
      return !!(ctx.configOpenAIKey || ctx.secretsStore.get(envKey));
    },
  };
}

/** Plain env-key providers (gemini, cerebras, ollama-cloud): store → env. */
function envKeyAuth(id: ProviderId, envKey: string): AuthProvider {
  return {
    async resolve(_opts, store) {
      const fromStore = store?.get(envKey);
      if (fromStore) return { provider: id, credential: fromStore, source: "secrets-store" };
      const fromEnv = process.env[envKey];
      if (fromEnv) return { provider: id, credential: fromEnv, source: "env" };
      return warnMissing(id);
    },
    hasCredential(ctx) {
      return !!ctx.secretsStore.get(envKey);
    },
  };
}

/** Custom provider: secrets store ONLY — no env fallback. */
function secretsOnlyAuth(id: ProviderId, envKey: string): AuthProvider {
  return {
    async resolve(_opts, store) {
      const fromStore = store?.get(envKey);
      if (fromStore) return { provider: id, credential: fromStore, source: "secrets-store" };
      return warnMissing(id);
    },
    hasCredential(ctx) {
      return !!ctx.secretsStore.get(envKey);
    },
  };
}

/** Keyless local provider (Ollama): fixed sentinel, always present. */
function sentinelAuth(id: ProviderId, value: string): AuthProvider {
  return {
    async resolve() {
      return { provider: id, credential: value, source: "sentinel" };
    },
    hasCredential() {
      return true;
    },
  };
}

/**
 * Adapter instances, one per provider id. The registry spreads `meta.auth`
 * from this map — keep it exhaustive over ProviderId.
 */
export const AUTH_PROVIDERS: Record<ProviderId, AuthProvider> = {
  anthropic: anthropicAuth(),
  codex: codexAuth(),
  xai: xaiAuth("XAI_API_KEY"),
  openai: openaiAuth("OPENAI_API_KEY"),
  gemini: envKeyAuth("gemini", "GEMINI_API_KEY"),
  cerebras: envKeyAuth("cerebras", "CEREBRAS_API_KEY"),
  "ollama-cloud": envKeyAuth("ollama-cloud", "OLLAMA_CLOUD_API_KEY"),
  custom: secretsOnlyAuth("custom", "CUSTOM_API_KEY"),
  local: sentinelAuth("local", "ollama"),
};
