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
 */

import { resolveCredential } from "./auth/resolve.js";
import { resolveProviderContext } from "./providers/resolve-provider-context.js";
import { backgroundModelFor } from "./providers/registry.js";
import type { ProviderId } from "./providers/provider-ids.js";
import { createLogger } from "./logger.js";

const logger = createLogger("llm-dispatch");

export type LLMProvider = "ollama" | "anthropic" | "openai" | "xai" | "codex";

export interface DispatchOptions {
  prompt: string;
  provider?: LLMProvider | "auto";
  /** Per-provider model override; falls back to the defaults below if absent. */
  ollamaModel?: string;
  anthropicModel?: string;
  openaiModel?: string;
  xaiModel?: string;
  codexModel?: string;
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
   * Anthropic-only: sent as base64 image content blocks per the Messages API.
   * Every other provider ignores this silently — callers doing vision work
   * must pin `provider: "anthropic"`. Absent/empty → the request body is
   * byte-identical to before this option existed.
   */
  images?: string[];
}

const DEFAULTS = {
  ollamaModel: "llama3:8b",
  temperature: 0,
  maxTokens: 200,
  timeoutMs: 30_000,
} as const;

// The four non-ollama dispatch providers map 1:1 onto registry ProviderIds.
// ollama isn't a separate registry provider, so its model stays a local default.
const DISPATCH_REGISTRY_ID: Record<Exclude<LLMProvider, "ollama">, ProviderId> = {
  anthropic: "anthropic", openai: "openai", xai: "xai", codex: "codex",
};
const DISPATCH_MODEL_FALLBACK: Record<Exclude<LLMProvider, "ollama">, string> = {
  anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini",
  xai: "grok-4.20-0309-non-reasoning", codex: "gpt-5.4-mini",
};
/** Background (cheap/fast) model for a dispatch provider, read from the registry
 *  (backgroundModelFor) so dispatch can't drift from the canonical per-provider
 *  background model. Falls back to a local literal only if the registry lacks one.
 *  xAI's entry is non-reasoning so a short single-shot completion isn't consumed
 *  by hidden chain-of-thought (which returns empty → null). */
export function dispatchBackgroundModel(provider: Exclude<LLMProvider, "ollama">): string {
  return backgroundModelFor(DISPATCH_REGISTRY_ID[provider], DISPATCH_MODEL_FALLBACK[provider]);
}

const DISPATCHABLE = new Set<LLMProvider>(["ollama", "anthropic", "openai", "xai", "codex"]);

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

  if (provider === "ollama") return callOllama(opts.prompt, opts.ollamaModel ?? DEFAULTS.ollamaModel, temp, maxTokens, timeout);
  if (provider === "anthropic") return callAnthropic(opts.prompt, opts.anthropicModel ?? dispatchBackgroundModel("anthropic"), temp, maxTokens, timeout, opts.rejectOAuth ?? false, opts.images);
  if (provider === "openai") return callOpenAI(opts.prompt, opts.openaiModel ?? dispatchBackgroundModel("openai"), temp, maxTokens, timeout);
  if (provider === "xai") return callXai(opts.prompt, opts.xaiModel ?? dispatchBackgroundModel("xai"), temp, maxTokens, timeout);
  if (provider === "codex") return callCodex(opts.prompt, opts.codexModel ?? dispatchBackgroundModel("codex"), temp, timeout);
  return null;
}

async function callOllama(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature, num_predict: maxTokens } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn(`ollama call failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as { response?: string };
    return data.response || null;
  } catch (e) {
    // Callers fall back to the next provider on null — without the warn
    // the user sees "all providers returned null" with zero context on
    // which one failed and why (timeout vs. network vs. JSON parse).
    logger.warn(`ollama call threw: ${(e as Error).message}`);
    return null;
  }
}

// Anthropic Messages API user-content shape: a bare string, or content blocks
// when images ride along (images precede the text so the model reads the
// question with the pixels already in context).
type AnthropicUserContent =
  | string
  | Array<
      | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
      | { type: "text"; text: string }
    >;

async function callAnthropic(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number, rejectOAuth: boolean, images?: string[]): Promise<string | null> {
  try {
    const resolved = await resolveCredential("anthropic", { rejectOAuth });
    if (!resolved) return null;
    const apiKey = resolved.credential;
    const isOAuth = apiKey.startsWith("oauth:");
    if (rejectOAuth && (isOAuth || !apiKey.startsWith("sk-ant-api"))) return null;
    const token = isOAuth ? apiKey.slice(6) : apiKey;
    const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (isOAuth) headers["Authorization"] = `Bearer ${token}`;
    else headers["x-api-key"] = token;
    // No images → content stays the bare prompt string, so existing call
    // sites produce the exact request body they always have.
    const content: AnthropicUserContent = images && images.length > 0
      ? [
          ...images.map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data } })),
          { type: "text" as const, text: prompt },
        ]
      : prompt;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: [{ role: "user", content }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn(`anthropic call failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text || null;
  } catch (e) {
    logger.warn(`anthropic call threw: ${(e as Error).message}`);
    return null;
  }
}

// OpenAI Chat Completions wire format — shared by OpenAI proper and every
// OpenAI-compatible endpoint (xAI's api.x.ai/v1 is byte-identical). One body,
// one parse, one error shape; the two callers differ only by credential id,
// baseURL, and log label. callOpenAI/callXai stay as named wrappers so the
// dispatch switch reads the same as the other providers.
async function callOpenAICompatible(
  label: string,
  credentialProvider: ProviderId,
  baseURL: string,
  prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number,
): Promise<string | null> {
  try {
    const resolved = await resolveCredential(credentialProvider);
    if (!resolved) return null;
    const apiKey = resolved.credential;
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn(`${label} call failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    logger.warn(`${label} call threw: ${(e as Error).message}`);
    return null;
  }
}

function callOpenAI(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number): Promise<string | null> {
  return callOpenAICompatible("openai", "openai", "https://api.openai.com/v1", prompt, model, temperature, maxTokens, timeoutMs);
}

function callXai(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number): Promise<string | null> {
  // xAI exposes an OpenAI-compatible endpoint at api.x.ai/v1; the OpenAI body
  // works unchanged. Auth comes from env XAI_API_KEY or the secrets store (the
  // chat path stores it there). Without this, every background classifier
  // (identity-extract, claim-verify, intent-classifier, …) silently no-ops for
  // xAI users — classify-with-llm hits the xAI fallback that returns null
  // before reaching this dispatcher.
  return callOpenAICompatible("xai", "xai", "https://api.x.ai/v1", prompt, model, temperature, maxTokens, timeoutMs);
}

async function callCodex(prompt: string, model: string, temperature: number, timeoutMs: number): Promise<string | null> {
  // Codex is a ChatGPT-subscription OAuth token, not an API key — it goes
  // through the canonical streaming client (the same one chat and
  // classify-with-llm use), not a raw fetch. Accumulate the streamed text into
  // a single completion. maxTokens has no equivalent here; extraction-shaped
  // outputs are short, so we read the stream to completion.
  try {
    const resolved = await resolveCredential("codex");
    if (!resolved) return null;
    const { streamCodexResponse } = await import("./codex-client/index.js");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      let acc = "";
      for await (const event of streamCodexResponse({
        token: resolved.credential, model, temperature,
        messages: [{ role: "user", content: prompt } as never],
        systemPrompt: "", tools: [], signal: ac.signal,
      })) {
        if (event.type === "text") acc += (event as { delta?: string }).delta || "";
      }
      return acc || null;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    logger.warn(`codex call threw: ${(e as Error).message}`);
    return null;
  }
}
