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
}

const DEFAULTS = {
  ollamaModel: "llama3:8b",
  anthropicModel: "claude-haiku-4-5-20251001",
  openaiModel: "gpt-4o-mini",
  // Non-reasoning so a short single-shot completion isn't consumed by hidden
  // chain-of-thought (which returns empty → null). Mirrors backgroundModelFor.
  xaiModel: "grok-4.20-0309-non-reasoning",
  codexModel: "gpt-5.4-mini",
  temperature: 0,
  maxTokens: 200,
  timeoutMs: 30_000,
} as const;

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
  if (provider === "anthropic") return callAnthropic(opts.prompt, opts.anthropicModel ?? DEFAULTS.anthropicModel, temp, maxTokens, timeout, opts.rejectOAuth ?? false);
  if (provider === "openai") return callOpenAI(opts.prompt, opts.openaiModel ?? DEFAULTS.openaiModel, temp, maxTokens, timeout);
  if (provider === "xai") return callXai(opts.prompt, opts.xaiModel ?? DEFAULTS.xaiModel, temp, maxTokens, timeout);
  if (provider === "codex") return callCodex(opts.prompt, opts.codexModel ?? DEFAULTS.codexModel, temp, timeout);
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

async function callAnthropic(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number, rejectOAuth: boolean): Promise<string | null> {
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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: [{ role: "user", content: prompt }] }),
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

async function callOpenAI(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number): Promise<string | null> {
  try {
    const resolved = await resolveCredential("openai");
    if (!resolved) return null;
    const apiKey = resolved.credential;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn(`openai call failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    logger.warn(`openai call threw: ${(e as Error).message}`);
    return null;
  }
}

async function callXai(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number): Promise<string | null> {
  // xAI exposes an OpenAI-compatible endpoint at api.x.ai/v1; wire-identical
  // to /v1/chat/completions on api.openai.com, so the OpenAI client shape
  // works unchanged. Auth comes from either env XAI_API_KEY or the secrets
  // store (chat path stores it there). Without this, every background
  // classifier (identity-extract, claim-verify, intent-classifier, etc.)
  // silently no-ops for xAI users — verified May 2026: identity-shape
  // statements ("my kid's name is X") didn't auto-save because
  // classify-with-llm hit the xAI/Gemini fallback that returns null
  // before reaching this dispatcher.
  try {
    const resolved = await resolveCredential("xai");
    if (!resolved) return null;
    const apiKey = resolved.credential;
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn(`xai call failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    logger.warn(`xai call threw: ${(e as Error).message}`);
    return null;
  }
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
