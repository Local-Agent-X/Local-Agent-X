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
import { AUTH_PROVIDERS, type AuthProvider } from "../auth/auth-provider.js";

export type CapabilitySupport = boolean | "target-dependent";

/** Provider capability flags. Used to gate reasoning_effort, tools, etc. */
export interface ProviderCapabilities {
  /** Whether every target accepts `tools`, or the exact target must prove it. */
  tools: CapabilitySupport;
  /** Whether every target accepts image input, or the exact target must prove it. */
  vision: CapabilitySupport;
  /** Whether every target streams, or the exact target must prove it. */
  streaming: CapabilitySupport;
  /** Whether the transport can consume local files without an image upload. */
  localFiles: boolean;
  /**
   * Whether to opt-in to `reasoning_effort` on the OpenAI Chat
   * Completions request. Matched per-model against the regex from
   * openai-http.ts (grok-4 family + grok-code-fast + grok-3-mini,
   * o1/o3/o4, gpt-5, gemini 2.5+, deepseek-r1, qwen reasoning). Lives
   * on the entry so we don't have one global regex pretending to be
   * provider-agnostic.
   */
  reasoning: RegExp | false;
  /**
   * Whether the provider's OpenAI-compat endpoint honors wire-level
   * `response_format: json_schema` structured output. Unset/false means
   * "don't count on it" — the param is best-effort everywhere (the adapter
   * self-heals a rejection by dropping it), so this flag is a routing hint,
   * not a hard gate.
   */
  structuredOutput?: CapabilitySupport;
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
   * Cheap/fast model for non-load-bearing background work (memory dream,
   * etc.) when the user hasn't pinned an explicit model. Prefer a
   * non-reasoning model: background jobs don't need chain-of-thought, and
   * reasoning models either burn cost/latency or — on providers that hide
   * reasoning server-side (OpenAI o-series) — stall the idle watchdog with
   * no stream to keep it alive. Unset → caller falls back to the resolved
   * default model. See backgroundModelFor().
   */
  backgroundModel?: string;
  /**
   * Resolved baseURL for the OpenAI client. Functions cover providers
   * whose URL is runtime-configurable (local Ollama, custom). Returning
   * null means "config missing — caller should bail."
   */
  baseURL: string | ((ctx: BaseURLContext) => string | null);
  /** Secret name in SecretsStore. Empty when no key is required (local). */
  envKey: string;
  capabilities: ProviderCapabilities;
  /** Credential resolution adapter — the auth seam. */
  auth: AuthProvider;
}

/** CLI transport — anthropic via the claude subprocess. */
export interface ProviderMetaCli {
  transport: "cli";
  id: ProviderId;
  label: string;
  models: string[];
  defaultModel: string;
  /** Cheap/fast background model — see ProviderMetaHttp.backgroundModel. */
  backgroundModel?: string;
  cliBinary: string;
  capabilities: ProviderCapabilities;
  /** Credential resolution adapter — the auth seam. */
  auth: AuthProvider;
}

export type ProviderMeta = ProviderMetaHttp | ProviderMetaCli;

/** Runtime context passed to baseURL resolvers. */
export interface BaseURLContext {
  ollamaUrl: string;
  customBaseURL?: string;
}

const REASONING_OPENAI_FAMILY = /^o[134]|gpt-5/i;
// xAI models that accept the `reasoning_effort` request param: grok-4 family
// (grok-4.5, grok-4.3, grok-4.20-*reasoning, grok-4.20-multi-agent) + grok-3-mini. The
// explicit `-non-reasoning` variant (grok-4.20-0309-non-reasoning) is excluded —
// sending reasoning_effort to it is ignored or rejected. grok-code-fast is also
// excluded: it reasons internally but does NOT accept the param, and sending it
// 400s the whole request ("does not support parameter reasoningEffort"). Without
// reasoning_effort set, the grok-4 family leaks chain-of-thought into
// `delta.content` instead of the separate `delta.reasoning_content` field, so we
// keep it set for them; grok-code-fast streams reasoning in the separate field
// regardless, handled by the adapter's thinking-delta path.
const REASONING_GROK = /^grok-(?:4|3-mini)(?!.*-non-reasoning)/i;
const REASONING_GEMINI = /gemini-(2\.5|3)/i;
const REASONING_OSS = /deepseek-r1|qwen.*reasoning|gpt-oss|glm-4\.7/i;

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  xai: {
    transport: "http",
    id: "xai",
    label: "xAI Grok",
    models: [
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
      // Coding-specialist models — selectable so the app-builder can run on a
      // model trained for agentic coding instead of the generalist grok-4.3.
      // resolveBuildModel honors whatever's selected, so picking one here drives
      // the build path. grok-code-fast-1: GA, SWE-Bench-Verified 70.8%, cheap.
      "grok-code-fast-1",
      "grok-build-0.1",
    ],
    defaultModel: "grok-4.5",
    // Non-reasoning variant: no chain-of-thought to burn time on, and it
    // sidesteps the reasoning-stream watchdog interaction entirely.
    backgroundModel: "grok-4.20-0309-non-reasoning",
    baseURL: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    capabilities: { tools: true, vision: false, streaming: true, localFiles: false, reasoning: REASONING_GROK, structuredOutput: true },
    auth: AUTH_PROVIDERS.xai,
  },
  openai: {
    transport: "http",
    id: "openai",
    label: "OpenAI API",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-4o", "gpt-4o-mini", "o3-pro"],
    defaultModel: "o3-pro",
    // Non-reasoning: the default o3-pro hides reasoning server-side, so a
    // long think streams nothing and the idle watchdog can't tell it from a
    // hang. gpt-4o-mini has no hidden think to stall on.
    backgroundModel: "gpt-4o-mini",
    baseURL: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    capabilities: { tools: true, vision: true, streaming: true, localFiles: false, reasoning: REASONING_OPENAI_FAMILY, structuredOutput: true },
    auth: AUTH_PROVIDERS.openai,
  },
  codex: {
    transport: "http",
    id: "codex",
    label: "OpenAI Codex",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
    defaultModel: "gpt-5.5",
    backgroundModel: "gpt-5.4-mini",
    // Codex uses ChatGPT OAuth via getApiKey(); chat-runner routes it
    // through its own adapter, not openai-compat. baseURL here is the
    // direct OpenAI endpoint as a fallback for any HTTP path that does
    // touch it.
    baseURL: "https://api.openai.com/v1",
    envKey: "",
    capabilities: { tools: true, vision: true, streaming: true, localFiles: false, reasoning: REASONING_OPENAI_FAMILY },
    auth: AUTH_PROVIDERS.codex,
  },
  anthropic: {
    transport: "cli",
    id: "anthropic",
    label: "Anthropic Claude",
    models: [
      "claude-opus-4-8",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
      "claude-opus-4-5",
    ],
    defaultModel: "claude-opus-4-8",
    backgroundModel: "claude-haiku-4-5",
    cliBinary: "claude",
    capabilities: { tools: true, vision: true, streaming: true, localFiles: true, reasoning: false },
    auth: AUTH_PROVIDERS.anthropic,
  },
  gemini: {
    transport: "http",
    id: "gemini",
    label: "Google Gemini",
    // GA aliases, not dated -preview-MM-DD snapshots (those get retired → 404).
    // PRO-class only for interactive use: the *flash* models empty out (return
    // an empty STOP) when sent LAX's full ~55KB system prompt + tools via the
    // native generateContent API — verified 2026-06-11 (flash works on a tiny
    // prompt, empties on the real one; pro handles it reliably). So flash is not
    // offered for chat. backgroundModel stays 2.0-flash — background agents use
    // compact prompts, not the big chat prompt.
    models: [
      "gemini-2.5-pro",
      "gemini-3.1-pro-preview",
      "gemini-3-pro-preview",
    ],
    defaultModel: "gemini-2.5-pro",
    backgroundModel: "gemini-2.0-flash",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    envKey: "GEMINI_API_KEY",
    capabilities: { tools: true, vision: true, streaming: true, localFiles: false, reasoning: REASONING_GEMINI },
    auth: AUTH_PROVIDERS.gemini,
  },
  cerebras: {
    transport: "http",
    id: "cerebras",
    label: "Cerebras",
    models: ["gpt-oss-120b", "zai-glm-4.7"],
    defaultModel: "gpt-oss-120b",
    baseURL: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    capabilities: { tools: true, vision: false, streaming: true, localFiles: false, reasoning: REASONING_OSS, structuredOutput: true },
    auth: AUTH_PROVIDERS.cerebras,
  },
  local: {
    transport: "http",
    id: "local",
    // The id stays "local" (settings.json on disk references it) but it no
    // longer means Ollama-only: models come from the src/local-runtimes/
    // discovery sweep (Ollama, LM Studio, vLLM, llama.cpp, manual adds).
    // baseURL here is the Ollama back-compat fallback; per-model runtime
    // resolution happens in the openai-compat adapter's resolve-target.
    label: "Local Models",
    models: [],
    defaultModel: "qwen2:7b",
    baseURL: (ctx) => `${ctx.ollamaUrl}/v1`,
    envKey: "",
    capabilities: { tools: "target-dependent", vision: "target-dependent", streaming: true, localFiles: false, reasoning: REASONING_OSS, structuredOutput: "target-dependent" },
    auth: AUTH_PROVIDERS.local,
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
    capabilities: { tools: true, vision: "target-dependent", streaming: true, localFiles: false, reasoning: REASONING_OSS, structuredOutput: "target-dependent" },
    auth: AUTH_PROVIDERS["ollama-cloud"],
  },
  custom: {
    transport: "http",
    id: "custom",
    label: "Custom Provider",
    models: ["custom-model"],
    defaultModel: "custom-model",
    baseURL: (ctx) => ctx.customBaseURL || null,
    envKey: "CUSTOM_API_KEY",
    capabilities: { tools: "target-dependent", vision: "target-dependent", streaming: "target-dependent", localFiles: false, reasoning: false, structuredOutput: "target-dependent" },
    auth: AUTH_PROVIDERS.custom,
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

/**
 * Model to use for cheap/fast background work on a provider. Returns the
 * provider's `backgroundModel` when set, else `fallback` (typically the
 * caller's resolved default model). Use for non-load-bearing jobs — memory
 * dream, etc. — that shouldn't run on a flagship reasoner.
 */
export function backgroundModelFor(id: ProviderId, fallback: string): string {
  return PROVIDERS[id]?.backgroundModel || fallback;
}
