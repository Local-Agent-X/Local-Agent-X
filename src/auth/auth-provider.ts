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
 *   - `custom` and `anthropic-api` resolve from the secrets store ONLY (no env
 *     fallback): an Anthropic key must be entered in LAX to be billed by LAX.
 *   - `anthropic` is the subscription sign-in only; xai OAuth XOR env.
 */
import type { ProviderId } from "../providers/provider-ids.js";
import type { SecretsStore } from "../secrets.js";
import { createLogger } from "../logger.js";
import { getAnthropicApiKey, loadAnthropicTokens, isAnthropicCliAuthenticated } from "./anthropic.js";
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
  /** Restart recovery pins the source selected at admission. A missing value
   * keeps normal precedence; a value resolves only that source. */
  requiredSource?: CredentialSource;
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

/** Anthropic: the picker's "subscription auth" entry — a Claude subscription
 *  sign-in only. An ANTHROPIC_API_KEY (environment or secrets store) is never
 *  used for it; see getAnthropicApiKey. The key has its own picker entry,
 *  `anthropic-api` (secretsOnlyAuth below). */
function anthropicAuth(): AuthProvider {
  const id: ProviderId = "anthropic";
  return {
    async resolve(opts) {
      if (opts.requiredSource && opts.requiredSource !== "oauth") return warnMissing(id);
      // A bulk caller that must not draw on the subscription gets nothing —
      // there is no other Anthropic credential to give it.
      if (opts.rejectOAuth) return null;
      try {
        return { provider: id, credential: await getAnthropicApiKey(), source: "oauth" };
      } catch {
        return warnMissing(id);
      }
    },
    hasCredential() {
      return !!loadAnthropicTokens() || isAnthropicCliAuthenticated();
    },
  };
}

/** Codex: ChatGPT OAuth (config key takes priority inside getApiKey). */
function codexAuth(): AuthProvider {
  const id: ProviderId = "codex";
  return {
    async resolve(opts) {
      if (opts.requiredSource && opts.requiredSource !== "oauth") return warnMissing(id);
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
      const required = opts.requiredSource;
      const rejectOAuth = opts.rejectOAuth === true;
      if (!required || required === "oauth") try {
        const oauth = await getXaiApiKey();
        if (oauth && !rejectOAuth) {
          return { provider: id, credential: oauth, source: "oauth" };
        }
      } catch { /* fall through */ }
      const fromStore = store?.get(envKey);
      if ((!required || required === "secrets-store") && fromStore) return { provider: id, credential: fromStore, source: "secrets-store" };
      const fromEnv = process.env[envKey];
      if ((!required || required === "env") && fromEnv) return { provider: id, credential: fromEnv, source: "env" };
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
      const required = opts.requiredSource;
      if ((!required || required === "config") && opts.configOpenAIKey) {
        return { provider: id, credential: opts.configOpenAIKey, source: "config" };
      }
      const fromStore = store?.get(envKey);
      if ((!required || required === "secrets-store") && fromStore) return { provider: id, credential: fromStore, source: "secrets-store" };
      const fromEnv = process.env[envKey];
      if ((!required || required === "env") && fromEnv) return { provider: id, credential: fromEnv, source: "env" };
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
    async resolve(opts, store) {
      const required = opts.requiredSource;
      const fromStore = store?.get(envKey);
      if ((!required || required === "secrets-store") && fromStore) return { provider: id, credential: fromStore, source: "secrets-store" };
      const fromEnv = process.env[envKey];
      if ((!required || required === "env") && fromEnv) return { provider: id, credential: fromEnv, source: "env" };
      return warnMissing(id);
    },
    hasCredential(ctx) {
      return !!ctx.secretsStore.get(envKey);
    },
  };
}

/** Secrets store ONLY — no env fallback. `custom`, and `anthropic-api`: the
 *  picker's "Anthropic API (direct key)". A key in the environment may belong
 *  to another program on the box; only a key the user saved in LAX is one
 *  they picked, and one LAX may bill (source "secrets-store" is billable —
 *  cost-tracker isBillableSource — and sizes on the api lane). */
function secretsOnlyAuth(id: ProviderId, envKey: string): AuthProvider {
  return {
    async resolve(opts, store) {
      if (opts.requiredSource && opts.requiredSource !== "secrets-store") return warnMissing(id);
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
    async resolve(opts) {
      if (opts.requiredSource && opts.requiredSource !== "sentinel") return warnMissing(id);
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
  "anthropic-api": secretsOnlyAuth("anthropic-api", "ANTHROPIC_API_KEY"),
  codex: codexAuth(),
  xai: xaiAuth("XAI_API_KEY"),
  openai: openaiAuth("OPENAI_API_KEY"),
  gemini: envKeyAuth("gemini", "GEMINI_API_KEY"),
  cerebras: envKeyAuth("cerebras", "CEREBRAS_API_KEY"),
  "ollama-cloud": envKeyAuth("ollama-cloud", "OLLAMA_CLOUD_API_KEY"),
  custom: secretsOnlyAuth("custom", "CUSTOM_API_KEY"),
  local: sentinelAuth("local", "ollama"),
};
