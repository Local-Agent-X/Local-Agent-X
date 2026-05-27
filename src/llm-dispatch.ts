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
 * Provider detection is opinionated per use case:
 *   - rejectOAuth: skip Anthropic if only an OAuth (CLI subscription) token is
 *     available. Bulk/automated workloads can't use OAuth, so they should fall
 *     through to OpenAI/Ollama instead.
 *   - preferEnvKeys: skip the ~/.lax/settings.json provider preference.
 *     Background jobs use whatever credentials are present, regardless of the
 *     user's chat-time provider choice.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { createLogger } from "./logger.js";

const logger = createLogger("llm-dispatch");

export type LLMProvider = "ollama" | "anthropic" | "openai" | "xai";

export interface DispatchOptions {
  prompt: string;
  provider?: LLMProvider | "auto";
  /** Per-provider model override; falls back to the defaults below if absent. */
  ollamaModel?: string;
  anthropicModel?: string;
  openaiModel?: string;
  xaiModel?: string;
  /** Sampling temperature (default 0). */
  temperature?: number;
  /** Max output tokens (default 200). */
  maxTokens?: number;
  /** Request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Reject Anthropic OAuth tokens — bulk workloads can't use CLI subscriptions. */
  rejectOAuth?: boolean;
  /** Skip ~/.lax/settings.json check during provider detection. */
  preferEnvKeys?: boolean;
}

const DEFAULTS = {
  ollamaModel: "llama3:8b",
  anthropicModel: "claude-haiku-4-5-20251001",
  openaiModel: "gpt-4o-mini",
  xaiModel: "grok-4",
  temperature: 0,
  maxTokens: 200,
  timeoutMs: 30_000,
} as const;

/** Pick a provider based on env + (optionally) user settings. Returns null if none usable. */
export function detectProvider(opts: { rejectOAuth?: boolean; preferEnvKeys?: boolean } = {}): LLMProvider | null {
  if (!opts.preferEnvKeys) {
    try {
      const settingsPath = join(getLaxDir(), "settings.json");
      if (existsSync(settingsPath)) {
        const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as { provider?: string };
        if (s.provider === "ollama") return "ollama";
        if (s.provider === "anthropic") return "anthropic";
        if (s.provider === "openai" || s.provider === "codex") return "openai";
      }
    } catch { /* fall through */ }
  }
  const ak = process.env.ANTHROPIC_API_KEY || "";
  if (ak && (!opts.rejectOAuth || ak.startsWith("sk-ant-api"))) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "ollama"; // last-ditch — will fail to null if Ollama isn't running
}

/** Single-shot text completion. Returns null on any failure. */
export async function dispatch(opts: DispatchOptions): Promise<string | null> {
  const provider = opts.provider === "auto" || !opts.provider
    ? detectProvider({ rejectOAuth: opts.rejectOAuth, preferEnvKeys: opts.preferEnvKeys })
    : opts.provider;
  if (!provider) return null;

  const temp = opts.temperature ?? DEFAULTS.temperature;
  const maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
  const timeout = opts.timeoutMs ?? DEFAULTS.timeoutMs;

  if (provider === "ollama") return callOllama(opts.prompt, opts.ollamaModel ?? DEFAULTS.ollamaModel, temp, maxTokens, timeout);
  if (provider === "anthropic") return callAnthropic(opts.prompt, opts.anthropicModel ?? DEFAULTS.anthropicModel, temp, maxTokens, timeout, opts.rejectOAuth ?? false);
  if (provider === "openai") return callOpenAI(opts.prompt, opts.openaiModel ?? DEFAULTS.openaiModel, temp, maxTokens, timeout);
  if (provider === "xai") return callXai(opts.prompt, opts.xaiModel ?? DEFAULTS.xaiModel, temp, maxTokens, timeout);
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
    let apiKey = process.env.ANTHROPIC_API_KEY || "";
    if (!apiKey) {
      try { apiKey = await (await import("./auth-anthropic.js")).getAnthropicApiKey(); } catch { /* no fallback key */ }
    }
    if (!apiKey) return null;
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
    const apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) return null;
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
    let apiKey = process.env.XAI_API_KEY || "";
    if (!apiKey) {
      try {
        const { getSecretsStoreSingleton } = await import("./secrets.js");
        apiKey = getSecretsStoreSingleton()?.get("XAI_API_KEY") || "";
      } catch { /* no secrets store available */ }
    }
    if (!apiKey) return null;
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
