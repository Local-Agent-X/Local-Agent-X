/**
 * Shared LLM dispatch — one place that knows how to call Ollama, Anthropic,
 * and OpenAI for short, single-shot completions. Used by:
 *   - memory-resolver.ts    (Mem0-style fact resolution)
 *   - memory-extract.ts     (chunk → fact extraction)
 *   - memory-hyde.ts        (hypothetical doc generation for retrieval)
 *   - operations/decomposer.ts (goal → phases planning)
 *
 * Returns `null` on any failure (network, auth, non-OK HTTP, parse error).
 * Caller treats null as "LLM unavailable, degrade gracefully" — never throws.
 *
 * Provider selection defers to the canonical store-aware resolver
 * (resolveProviderContext) — the user's configured provider, with its
 * credential resolved from the secrets store / OAuth / env. The one knob:
 *   - rejectOAuth: refuse an Anthropic OAuth (CLI subscription) token. Bulk
 *     workloads can't drive the CLI subprocess for sequential calls, so an
 *     Anthropic-OAuth user degrades to null rather than hammering it.
 *
 * Anthropic subscription credentials (cli sentinel / oauth: / sk-ant-oat) are
 * NEVER sent over direct HTTP — that path is banned (429 since April 2026).
 * When accepted (rejectOAuth off), they route through the canonical
 * streamAnthropicResponse client, which uses the official CLI proxy.
 *
 * This file owns WHICH provider and WHICH model. How each provider's wire
 * actually works lives in the two legs, split out under the 400-LOC gate:
 * llm-dispatch/ollama.js (local) and llm-dispatch/hosted.js (anthropic,
 * openai, xai, codex). The dependency is one-way — the legs never import back.
 */

import { resolveProviderContext } from "./providers/resolve-provider-context.js";
import { backgroundModelFor, PROVIDERS } from "./providers/registry.js";
import type { ProviderId } from "./providers/provider-ids.js";
import type { ProviderRequest } from "./providers/adapter/types.js";
import { createLogger } from "./logger.js";
import { callOllama, resolveOllamaDispatchModel } from "./llm-dispatch/ollama.js";
import { callAnthropic, callCodex, callOpenAI, callOpenAICompatible, callXai } from "./llm-dispatch/hosted.js";

const logger = createLogger("llm-dispatch");

export type LLMProvider = "ollama" | "local" | "anthropic" | "openai" | "xai" | "codex";

type RegistryDispatchProvider = Exclude<LLMProvider, "ollama" | "local">;

export interface LocalDispatchTarget {
  runtimeId: string;
  kind: "ollama" | "openai-compat";
  endpointBaseUrl: string;
  chatBaseUrl: string;
  model: string;
  apiKey: string;
}

export interface DispatchOptions {
  prompt: string;
  provider?: LLMProvider | "auto";
  /** Per-provider model override; falls back to the defaults below if absent. */
  ollamaModel?: string;
  anthropicModel?: string;
  openaiModel?: string;
  xaiModel?: string;
  codexModel?: string;
  /** Exact, already-admitted local runtime selected from current certification evidence. */
  localTarget?: LocalDispatchTarget;
  /** Sampling temperature (default 0). */
  temperature?: number;
  /** Max output tokens (default 200). */
  maxTokens?: number;
  /** Request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Reject Anthropic OAuth tokens — bulk workloads can't use CLI subscriptions. */
  rejectOAuth?: boolean;
  /**
   * Base64 PNG images (no `data:` prefix) attached BEFORE the prompt text.
   * Carried on the Anthropic path (Messages image blocks) AND the OpenAI-compat
   * path (openai/xai → `image_url` blocks), so a vision dispatch works on
   * whichever provider the user is on. When images are present the router grades
   * with the ACTIVE model (not the cheap background one). Every hosted provider
   * carries them: Anthropic (API-key direct HTTP AND subscription/OAuth via the
   * CLI proxy — convertUserContent → image blocks), openai/xai (image_url), and
   * Codex (convertMessagesToInput → Responses-API input_image). Only ollama/local
   * ignore them. Absent/empty → the body is byte-identical to before this option.
   */
  images?: string[];
  /**
   * Wire-level structured output (`response_format: json_schema`), same shape
   * as ProviderRequest.responseFormat. Sent only on providers whose registry
   * entry sets capabilities.structuredOutput (openai and xai on the dispatch
   * paths); every other provider (ollama, anthropic, codex) ignores it
   * silently — callers MUST NOT depend on it being honored and should still
   * parse the output defensively. Absent → the request body is byte-identical
   * to before this option existed.
   */
  responseFormat?: ProviderRequest["responseFormat"];
}

const DEFAULTS = {
  temperature: 0,
  maxTokens: 200,
  timeoutMs: 30_000,
} as const;

// The four non-ollama dispatch providers map 1:1 onto registry ProviderIds.
// ollama isn't a separate registry provider, so its model stays a local default.
const DISPATCH_REGISTRY_ID: Record<RegistryDispatchProvider, ProviderId> = {
  anthropic: "anthropic", openai: "openai", xai: "xai", codex: "codex",
};
const DISPATCH_MODEL_FALLBACK: Record<RegistryDispatchProvider, string> = {
  anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini",
  xai: "grok-4.20-0309-non-reasoning", codex: "gpt-5.4-mini",
};
/** Background (cheap/fast) model for a dispatch provider, read from the registry
 *  (backgroundModelFor) so dispatch can't drift from the canonical per-provider
 *  background model. Falls back to a local literal only if the registry lacks one.
 *  xAI's entry is non-reasoning so a short single-shot completion isn't consumed
 *  by hidden chain-of-thought (which returns empty → null). */
export function dispatchBackgroundModel(provider: RegistryDispatchProvider): string {
  return backgroundModelFor(DISPATCH_REGISTRY_ID[provider], DISPATCH_MODEL_FALLBACK[provider]);
}

/** The provider's DEFAULT (chat) model — the multimodal one actually in play for
 *  a user's work. Used for vision dispatches (images present) instead of the
 *  cheap background model, because a provider's background pick isn't uniformly
 *  vision-capable (xAI's is a non-reasoning text model). Single source of truth:
 *  the registry's defaultModel. */
export function dispatchDefaultModel(provider: RegistryDispatchProvider): string {
  return PROVIDERS[DISPATCH_REGISTRY_ID[provider]]?.defaultModel || DISPATCH_MODEL_FALLBACK[provider];
}

/** Whether a dispatch provider's registry entry advertises wire-level
 *  structured output (capabilities.structuredOutput). The registry is the
 *  single source of truth — dispatch consults it instead of hardcoding a
 *  provider list, so flipping the flag there is enough to change routing. */
export function dispatchStructuredOutputEnabled(provider: RegistryDispatchProvider): boolean {
  return PROVIDERS[DISPATCH_REGISTRY_ID[provider]]?.capabilities.structuredOutput === true;
}

const DISPATCHABLE = new Set<LLMProvider>(["ollama", "local", "anthropic", "openai", "xai", "codex"]);

/**
 * Resolve which provider to call. Defers to the canonical store-aware resolver
 * (resolveProviderContext) so the user's configured provider — whose key may
 * live in the secrets store or be an OAuth token, not an env var — is honored.
 * The old env-only logic couldn't see store credentials and dropped store users
 * (xAI, Codex) through to a dead-ollama last-ditch that 404-spammed. Returns
 * null when no provider this module can call is usable; callers degrade.
 */
export async function detectProvider(opts: { rejectOAuth?: boolean } = {}): Promise<LLMProvider | null> {
  const ctx = await resolveProviderContext();
  if (ctx) {
    const p = (ctx.provider === "local" ? "ollama" : ctx.provider) as LLMProvider;
    if (DISPATCHABLE.has(p)) return p;
  }
  // No usable configured provider — fall back to a raw env key if one is set.
  const ak = process.env.ANTHROPIC_API_KEY || "";
  if (ak && (!opts.rejectOAuth || ak.startsWith("sk-ant-api"))) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.XAI_API_KEY) return "xai";
  return null;
}

/** Single-shot text completion. Returns null on any failure. */
export async function dispatch(opts: DispatchOptions): Promise<string | null> {
  const provider = opts.provider === "auto" || !opts.provider
    ? await detectProvider({ rejectOAuth: opts.rejectOAuth })
    : opts.provider;
  if (!provider) return null;

  const temp = opts.temperature ?? DEFAULTS.temperature;
  const maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
  const timeout = opts.timeoutMs ?? DEFAULTS.timeoutMs;

  if (provider === "ollama") {
    const ollamaModel = opts.ollamaModel ?? await resolveOllamaDispatchModel();
    if (!ollamaModel) {
      logger.warn("no chat-capable Ollama model installed — skipping dispatch");
      return null;
    }
    return callOllama(opts.prompt, ollamaModel, temp, maxTokens, timeout);
  }
  if (provider === "local") {
    const target = opts.localTarget;
    if (!target || !opts.ollamaModel || opts.ollamaModel !== target.model) return null;
    const { isCertifiedLocalClassifierTargetCurrent } = await import("./local-runtimes/index.js");
    if (!isCertifiedLocalClassifierTargetCurrent(target)) return null;
    if (target.kind === "ollama") {
      return callOllama(
        opts.prompt, opts.ollamaModel, temp, maxTokens, timeout, target.endpointBaseUrl,
      );
    }
    return callOpenAICompatible(
      "local", null, target.chatBaseUrl, opts.prompt, opts.ollamaModel,
      temp, maxTokens, timeout, undefined, target.apiKey,
    );
  }
  // A screenshot riding along (vision) grades with the model the user is
  // ACTIVELY on — subscription plans make that free, and a provider's cheap
  // background model isn't uniformly vision-capable (xAI's is a non-reasoning
  // text model). The active model comes from the resolved provider context;
  // falls back to the provider's default chat model. Text dispatches keep the
  // cheap background model unchanged, and never touch resolveProviderContext.
  const hasImages = (opts.images?.length ?? 0) > 0;
  const modelFor = async (p: RegistryDispatchProvider, pinned: string | undefined): Promise<string> => {
    if (pinned) return pinned;
    if (!hasImages) return dispatchBackgroundModel(p);
    // Anthropic's background model (Haiku) is already vision-capable, so keep it
    // — and skip the provider-context resolve (it would also consume a
    // credential the caller may have mocked). openai/xai backgrounds are NOT
    // vision-capable (xAI's is a non-reasoning text model), so grade with the
    // user's ACTIVE model when the resolved provider matches this one (the vision
    // judge dispatches "auto", so it does), else the provider's default.
    if (p === "anthropic") return dispatchBackgroundModel(p);
    const ctx = await resolveProviderContext().catch(() => null);
    const active = ctx && ctx.provider === p ? (ctx as { model?: string }).model : undefined;
    return active || dispatchDefaultModel(p);
  };
  if (provider === "anthropic") return callAnthropic(opts.prompt, await modelFor("anthropic", opts.anthropicModel), temp, maxTokens, timeout, opts.rejectOAuth ?? false, opts.images);
  if (provider === "openai") return callOpenAI(opts.prompt, await modelFor("openai", opts.openaiModel), temp, maxTokens, timeout, opts.images, dispatchStructuredOutputEnabled("openai") ? opts.responseFormat : undefined);
  if (provider === "xai") return callXai(opts.prompt, await modelFor("xai", opts.xaiModel), temp, maxTokens, timeout, opts.images, dispatchStructuredOutputEnabled("xai") ? opts.responseFormat : undefined);
  if (provider === "codex") return callCodex(opts.prompt, await modelFor("codex", opts.codexModel), temp, timeout, opts.images);
  return null;
}
