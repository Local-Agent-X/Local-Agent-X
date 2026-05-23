/**
 * Single source of truth for per-provider metadata.
 *
 * Adding a provider should require editing ONE file (this one) for the
 * backend. resolve-provider, settings/providers, openai-compat, and the
 * UI registry endpoint all read from PROVIDERS.
 *
 * Anthropic is special: OAuth on the Max plan only works through the
 * Claude CLI subprocess — direct HTTP fails for Sonnet/Opus. That's not
 * drift to refactor away. The discriminated union on `transport`
 * encodes the split as a first-class shape so it can't be accidentally
 * collapsed back into an `if (provider === "anthropic")` branch.
 */
import type { ProviderId } from "./provider-ids.js";

/** Provider capability flags. Used to gate reasoning_effort, tools, etc. */
export interface ProviderCapabilities {
  /** Whether the provider's chat completion API accepts `tools`. */
  tools: boolean;
  /** Whether the provider streams via SSE. */
  streaming: boolean;
  /**
   * Whether to opt-in to `reasoning_effort` on the OpenAI Chat
   * Completions request. Matched per-model against the regex from
   * openai-http.ts (grok-3-mini-reasoning, o1/o3/o4, gpt-5, gemini 2.5+,
   * deepseek-r1, qwen reasoning). Lives on the entry so we don't have
   * one global regex pretending to be provider-agnostic.
   */
  reasoning: RegExp | false;
}

/** HTTP transport — OpenAI Chat Completions wire format. */
export interface ProviderMetaHttp {
  transport: "http";
  id: ProviderId;
  label: string;
  /** Static model list. Some providers (local, ollama-cloud) populate
   *  models dynamically at runtime; their static list may be empty. */
  models: string[];
  defaultModel: string;
  /**
   * Resolved baseURL for the OpenAI client. Functions cover providers
   * whose URL is runtime-configurable (local Ollama, custom). Returning
   * null means "config missing — caller should bail."
   */
  baseURL: string | ((ctx: BaseURLContext) => string | null);
  /** Secret name in SecretsStore. Empty when no key is required (local). */
  envKey: string;
  capabilities: ProviderCapabilities;
}

/** CLI transport — anthropic via the claude subprocess. */
export interface ProviderMetaCli {
  transport: "cli";
  id: ProviderId;
  label: string;
  models: string[];
  defaultModel: string;
  cliBinary: string;
  capabilities: ProviderCapabilities;
}

export type ProviderMeta = ProviderMetaHttp | ProviderMetaCli;

/** Runtime context passed to baseURL resolvers. */
export interface BaseURLContext {
  ollamaUrl: string;
  customBaseURL?: string;
}

const REASONING_OPENAI_FAMILY = /^o[134]|gpt-5/i;
const REASONING_GROK = /grok-3-mini-reasoning/i;
const REASONING_GEMINI = /gemini-(2\.5|3)/i;
const REASONING_OSS = /deepseek-r1|qwen.*reasoning|gpt-oss|glm-4\.7/i;

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  xai: {
    transport: "http",
    id: "xai",
    label: "xAI Grok",
    models: ["grok-4", "grok-4-fast", "grok-4-heavy", "grok-code-fast-1", "grok-3", "grok-3-mini"],
    defaultModel: "grok-4",
    baseURL: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    capabilities: { tools: true, streaming: true, reasoning: REASONING_GROK },
  },
  openai: {
    transport: "http",
    id: "openai",
    label: "OpenAI API",
    models: ["gpt-4o", "gpt-4o-mini", "o3-pro"],
    defaultModel: "o3-pro",
    baseURL: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    capabilities: { tools: true, streaming: true, reasoning: REASONING_OPENAI_FAMILY },
  },
  codex: {
    transport: "http",
    id: "codex",
    label: "OpenAI Codex",
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
    defaultModel: "gpt-5.5",
    // Codex uses ChatGPT OAuth via getApiKey(); chat-runner routes it
    // through its own adapter, not openai-compat. baseURL here is the
    // direct OpenAI endpoint as a fallback for any HTTP path that does
    // touch it.
    baseURL: "https://api.openai.com/v1",
    envKey: "",
    capabilities: { tools: true, streaming: true, reasoning: REASONING_OPENAI_FAMILY },
  },
  anthropic: {
    transport: "cli",
    id: "anthropic",
    label: "Anthropic Claude",
    models: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
      "claude-opus-4-5",
    ],
    defaultModel: "claude-opus-4-7",
    cliBinary: "claude",
    capabilities: { tools: true, streaming: true, reasoning: false },
  },
  gemini: {
    transport: "http",
    id: "gemini",
    label: "Google Gemini",
    models: [
      "gemini-2.0-flash",
      "gemini-2.5-pro-preview-05-06",
      "gemini-2.5-flash-preview-05-20",
    ],
    defaultModel: "gemini-2.5-pro-preview-05-06",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    envKey: "GEMINI_API_KEY",
    capabilities: { tools: true, streaming: true, reasoning: REASONING_GEMINI },
  },
  cerebras: {
    transport: "http",
    id: "cerebras",
    label: "Cerebras",
    models: ["gpt-oss-120b", "zai-glm-4.7"],
    defaultModel: "gpt-oss-120b",
    baseURL: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    capabilities: { tools: true, streaming: true, reasoning: REASONING_OSS },
  },
  local: {
    transport: "http",
    id: "local",
    label: "Ollama",
    models: [],
    defaultModel: "qwen2:7b",
    baseURL: (ctx) => `${ctx.ollamaUrl}/v1`,
    envKey: "",
    capabilities: { tools: true, streaming: true, reasoning: REASONING_OSS },
  },
  "ollama-cloud": {
    transport: "http",
    id: "ollama-cloud",
    label: "Ollama Turbo (cloud)",
    models: [],
    defaultModel: "",
    // Resolved via getCloudOllamaCallTarget() in openai-compat.ts —
    // its return value already pairs baseURL with the cloud apiKey and
    // returns null when the cache is cold. baseURL here would lie
    // about that, so we mark it null-by-context.
    baseURL: () => null,
    envKey: "OLLAMA_CLOUD_API_KEY",
    capabilities: { tools: true, streaming: true, reasoning: REASONING_OSS },
  },
  custom: {
    transport: "http",
    id: "custom",
    label: "Custom Provider",
    models: ["custom-model"],
    defaultModel: "custom-model",
    baseURL: (ctx) => ctx.customBaseURL || null,
    envKey: "CUSTOM_API_KEY",
    capabilities: { tools: true, streaming: true, reasoning: false },
  },
};

/** Type guard — narrows ProviderMeta to the http variant. */
export function isHttpProvider(
  meta: ProviderMeta,
): meta is ProviderMetaHttp {
  return meta.transport === "http";
}

/**
 * Resolve the OpenAI-compat baseURL for a provider at runtime.
 * Returns null when the provider is CLI-transport (anthropic) or when
 * required runtime config is missing (e.g., custom with no baseURL set).
 */
export function resolveBaseURL(
  id: ProviderId,
  ctx: BaseURLContext,
): string | null {
  const meta = PROVIDERS[id];
  if (!isHttpProvider(meta)) return null;
  return typeof meta.baseURL === "function" ? meta.baseURL(ctx) : meta.baseURL;
}

/** Whether the given model on the given provider opts into reasoning_effort. */
export function isReasoningModel(id: ProviderId, model: string): boolean {
  const re = PROVIDERS[id]?.capabilities.reasoning;
  return re ? re.test(model) : false;
}
