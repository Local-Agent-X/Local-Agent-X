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
 * actually works lives in the two legs:
 * llm-dispatch/ollama.js (local) and llm-dispatch/hosted.js (anthropic,
 * openai, xai, codex). The dependency is one-way — the legs never import back.
 */

import { resolveProviderContext } from "./providers/resolve-provider-context.js";
import { isReasoningModel, PROVIDERS } from "./providers/registry.js";
import { anthropicThinkingOffMode } from "./anthropic-models.js";
import { resolveBackgroundModel } from "./providers/background-model.js";
import type { ProviderId } from "./providers/provider-ids.js";
import type { ProviderRequest } from "./providers/adapter/types.js";
import { createLogger } from "./logger.js";
import { callOllama } from "./llm-dispatch/ollama.js";
import { callAnthropic, callCodex, callOpenAI, callOpenAICompatible, callXai } from "./llm-dispatch/hosted.js";

const logger = createLogger("llm-dispatch");

export type LLMProvider = "ollama" | "local" | "anthropic" | "anthropic-api" | "openai" | "xai" | "codex";

type RegistryDispatchProvider = Exclude<LLMProvider, "ollama" | "local">;

export interface LocalDispatchTarget {
  runtimeId: string;
  kind: "ollama" | "openai-compat";
  endpointBaseUrl: string;
  chatBaseUrl: string;
  model: string;
  apiKey: string;
}

/** The discovered runtime serving the chat model, where a background call on
 *  that model goes: the same runtime chat requests go to (resolve-target.ts).
 *  Default Ollama may not have the model at all when LM Studio serves chat. */
export interface LocalRuntimeRoute {
  kind: "ollama" | "openai-compat";
  endpointBaseUrl: string;
  chatBaseUrl: string;
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
  /** Ollama provider only: send `ollamaModel` to this runtime instead of default Ollama. */
  localRuntime?: LocalRuntimeRoute;
  /** Sampling temperature (default 0). */
  temperature?: number;
  /** Max output tokens (default 200). */
  maxTokens?: number;
  /** Request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /**
   * Ollama only: false asks a thinking model to answer without a reasoning
   * pass. A verdict or summary wants the answer; muse spent a review gate's
   * whole budget thinking and returned nothing (2026-09-17). Ignored by
   * models that do not think.
   */
  think?: boolean;
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

// The non-ollama dispatch providers map 1:1 onto registry ProviderIds.
// ollama isn't a separate registry provider, so its model stays a local default.
const DISPATCH_REGISTRY_ID: Record<RegistryDispatchProvider, ProviderId> = {
  anthropic: "anthropic", "anthropic-api": "anthropic-api", openai: "openai", xai: "xai", codex: "codex",
};
/** The provider's DEFAULT (chat) model, from the registry: what a dispatch runs on
 *  when the user is not chatting on this provider, so no model of ours is known. */
export function dispatchDefaultModel(provider: RegistryDispatchProvider): string {
  return PROVIDERS[DISPATCH_REGISTRY_ID[provider]]?.defaultModel || "";
}

/**
 * The model a hosted dispatch runs on when the caller names none: the user's chat
 * model when they are chatting on this provider, else the provider's default. It
 * used to be the provider's declared fast tier (claude-haiku-4-5, gpt-5.4-mini, a
 * non-reasoning grok), a model the account may not serve (a ChatGPT plan refuses
 * gpt-5.4-mini) and that answers worse than the one the user chose; the protocol
 * curator's whole report was lost that way (2026-10-25). Side work runs on the model
 * the user is on (owner, 2026-09-23): providers/background-model.ts is the one
 * place that answers which model that is.
 */
export async function dispatchModel(provider: RegistryDispatchProvider): Promise<string> {
  const id = DISPATCH_REGISTRY_ID[provider];
  const ctx = await resolveProviderContext().catch(() => null);
  const chat = ctx && ctx.provider === id ? (ctx as { model?: string }).model ?? "" : "";
  return (await resolveBackgroundModel(id, chat || dispatchDefaultModel(provider))).model;
}

/**
 * A thinking model spends its output budget thinking first, and on Fable 5 / Opus
 * 5.5 thinking cannot be turned off: a caller's 80-token cap (the memory resolver's
 * one OP= line) would be gone before the answer began. The cap is a guard against
 * runaway output, not a spend, so on such a model it is raised to this floor; every
 * other model gets thinking off and keeps the caller's cap.
 */
export const THINKING_HEADROOM_TOKENS = 4096;
export function dispatchMaxTokens(provider: RegistryDispatchProvider, model: string, requested: number): number {
  const anthropic = provider === "anthropic" || provider === "anthropic-api";
  return anthropic && anthropicThinkingOffMode(model) === "always-on" ? Math.max(requested, THINKING_HEADROOM_TOKENS) : requested;
}

/** Whether a dispatch provider's registry entry advertises wire-level
 *  structured output (capabilities.structuredOutput). The registry is the
 *  single source of truth — dispatch consults it instead of hardcoding a
 *  provider list, so flipping the flag there is enough to change routing. */
export function dispatchStructuredOutputEnabled(provider: RegistryDispatchProvider): boolean {
  return PROVIDERS[DISPATCH_REGISTRY_ID[provider]]?.capabilities.structuredOutput === true;
}

const DISPATCHABLE = new Set<LLMProvider>(["ollama", "local", "anthropic", "anthropic-api", "openai", "xai", "codex"]);

/**
 * Resolve which provider to call. Defers to the canonical store-aware resolver
 * (resolveProviderContext) so the user's configured provider — whose key may
 * live in the secrets store or be an OAuth token, not an env var — is honored.
 * The old env-only logic couldn't see store credentials and dropped store users
 * (xAI, Codex) through to a dead-ollama last-ditch that 404-spammed. Returns
 * null when no provider this module can call is usable; callers degrade.
 */
export async function detectProvider(): Promise<LLMProvider | null> {
  const ctx = await resolveProviderContext();
  if (ctx) {
    const p = (ctx.provider === "local" ? "ollama" : ctx.provider) as LLMProvider;
    if (DISPATCHABLE.has(p)) return p;
  }
  // No usable configured provider: nothing runs. A raw key in the environment
  // was never picked in LAX — it may belong to another project — so background
  // work does not quietly bill it.
  return null;
}

/**
 * The model a local dispatch runs on when the caller names none: the answer
 * resolveBackgroundModel gives every background caller (the user's
 * localClassifierModel pin, else the chat model). Picking the smallest
 * installed model instead loaded a second model beside the chat model, and the
 * two together overfilled the GPU: the chat model's prefill ran 3-14x slower
 * for as long as the small one stayed resident (2026-10-14 measurements).
 */
async function localBackgroundModel(): Promise<{ model: string; localTarget?: LocalDispatchTarget; localRuntime?: LocalRuntimeRoute } | null> {
  const ctx = await resolveProviderContext();
  const chatModel = ctx?.provider === "local" ? ctx.model : "";
  const { model, certifiedLocalTarget, chatRuntime } = await resolveBackgroundModel("local", chatModel);
  if (!model) return null;
  return {
    model,
    localTarget: certifiedLocalTarget ? { ...certifiedLocalTarget, apiKey: ctx?.apiKey ?? "" } : undefined,
    localRuntime: chatRuntime ? { ...chatRuntime, apiKey: ctx?.apiKey || "ollama" } : undefined,
  };
}

/** A local model at the runtime that serves it: Ollama's native generate, or
 *  the OpenAI-compatible chat endpoint (LM Studio, vLLM, llama.cpp). */
function callLocalRuntime(
  runtime: LocalRuntimeRoute | undefined, prompt: string, model: string,
  temperature: number, maxTokens: number, timeoutMs: number, think: boolean | undefined,
): Promise<string | null> {
  if (runtime && runtime.kind !== "ollama") {
    return callOpenAICompatible(
      "local", null, runtime.chatBaseUrl, prompt, model, temperature, maxTokens, timeoutMs,
      undefined, runtime.apiKey, undefined, think === false ? "none" : undefined,
    );
  }
  return callOllama(prompt, model, temperature, maxTokens, timeoutMs, runtime?.endpointBaseUrl, think);
}

/** Single-shot text completion. Returns null on any failure. */
export async function dispatch(opts: DispatchOptions): Promise<string | null> {
  const provider = opts.provider === "auto" || !opts.provider
    ? await detectProvider()
    : opts.provider;
  if (!provider) return null;

  const temp = opts.temperature ?? DEFAULTS.temperature;
  const maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
  const timeout = opts.timeoutMs ?? DEFAULTS.timeoutMs;

  if (provider === "ollama") {
    if (opts.ollamaModel) {
      return callLocalRuntime(opts.localRuntime, opts.prompt, opts.ollamaModel, temp, maxTokens, timeout, opts.think);
    }
    const background = await localBackgroundModel();
    if (!background) {
      logger.warn("no local background model (no localClassifierModel and no local chat model) — skipping dispatch");
      return null;
    }
    // The background model is usually the chat model now, and a thinking chat
    // model spends a short output budget reasoning: the memory resolver's 80
    // tokens ran out before its OP= line on every qwen3.6:27b call
    // (2026-10-18). A background completion wants the answer; a caller that
    // wants a reasoning pass says so.
    const think = opts.think ?? false;
    if (background.localTarget) {
      return dispatch({ ...opts, think, provider: "local", ollamaModel: background.model, localTarget: background.localTarget });
    }
    return callLocalRuntime(background.localRuntime, opts.prompt, background.model, temp, maxTokens, timeout, think);
  }
  if (provider === "local") {
    const target = opts.localTarget;
    if (!target || !opts.ollamaModel || opts.ollamaModel !== target.model) return null;
    const { isCertifiedLocalClassifierTargetCurrent } = await import("./local-runtimes/index.js");
    if (!isCertifiedLocalClassifierTargetCurrent(target)) return null;
    if (target.kind === "ollama") {
      return callOllama(
        opts.prompt, opts.ollamaModel, temp, maxTokens, timeout, target.endpointBaseUrl, opts.think,
      );
    }
    return callOpenAICompatible(
      "local", null, target.chatBaseUrl, opts.prompt, opts.ollamaModel,
      temp, maxTokens, timeout, undefined, target.apiKey, undefined, opts.think === false ? "none" : undefined,
    );
  }
  // The caller's model, else the user's (dispatchModel). A screenshot riding
  // along (vision) is fine either way: the chat model sees images.
  const pinned = provider === "anthropic" || provider === "anthropic-api" ? opts.anthropicModel
    : provider === "openai" ? opts.openaiModel : provider === "xai" ? opts.xaiModel : opts.codexModel;
  const model = pinned || (await dispatchModel(provider));
  if (!model) return null;
  // A short answer, not a reasoning pass: thinking off where the model allows,
  // low effort where it does not (dispatchMaxTokens says why the cap moves).
  const cap = dispatchMaxTokens(provider, model, maxTokens);
  if (provider === "anthropic" || provider === "anthropic-api") {
    return callAnthropic(provider, opts.prompt, model, temp, cap, timeout, opts.rejectOAuth ?? false, opts.images);
  }
  const lowEffort = (id: ProviderId): "low" | undefined => (isReasoningModel(id, model) ? "low" : undefined);
  if (provider === "openai") return callOpenAI(opts.prompt, model, temp, cap, timeout, opts.images, dispatchStructuredOutputEnabled("openai") ? opts.responseFormat : undefined, lowEffort("openai"));
  if (provider === "xai") return callXai(opts.prompt, model, temp, cap, timeout, opts.images, dispatchStructuredOutputEnabled("xai") ? opts.responseFormat : undefined, lowEffort("xai"));
  if (provider === "codex") return callCodex(opts.prompt, model, temp, timeout, opts.images);
  return null;
}
