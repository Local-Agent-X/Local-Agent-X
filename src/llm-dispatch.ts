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
 */

import { resolveCredential } from "./auth/resolve.js";
import { usesAnthropicSubscriptionAuth } from "./anthropic-models.js";
import { resolveProviderContext } from "./providers/resolve-provider-context.js";
import { backgroundModelFor, PROVIDERS } from "./providers/registry.js";
import type { ProviderId } from "./providers/provider-ids.js";
import type { ProviderRequest } from "./providers/adapter/types.js";
import { createLogger } from "./logger.js";
import { getRuntimeConfig } from "./config.js";

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

/** Whether a dispatch provider's registry entry advertises wire-level
 *  structured output (capabilities.structuredOutput). The registry is the
 *  single source of truth — dispatch consults it instead of hardcoding a
 *  provider list, so flipping the flag there is enough to change routing. */
export function dispatchStructuredOutputEnabled(provider: Exclude<LLMProvider, "ollama">): boolean {
  return PROVIDERS[DISPATCH_REGISTRY_ID[provider]]?.capabilities.structuredOutput === true;
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
  if (provider === "openai") return callOpenAI(opts.prompt, opts.openaiModel ?? dispatchBackgroundModel("openai"), temp, maxTokens, timeout, dispatchStructuredOutputEnabled("openai") ? opts.responseFormat : undefined);
  if (provider === "xai") return callXai(opts.prompt, opts.xaiModel ?? dispatchBackgroundModel("xai"), temp, maxTokens, timeout, dispatchStructuredOutputEnabled("xai") ? opts.responseFormat : undefined);
  if (provider === "codex") return callCodex(opts.prompt, opts.codexModel ?? dispatchBackgroundModel("codex"), temp, timeout);
  return null;
}

async function callOllama(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number): Promise<string | null> {
  try {
    const base = getRuntimeConfig().ollamaUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/api/generate`, {
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
    if (usesAnthropicSubscriptionAuth(apiKey)) {
      // Anthropic banned subscription auth over direct HTTP (April 2026 —
      // every request 429s). Subscription-style credentials ("cli" sentinel,
      // oauth: prefix, sk-ant-oat tokens) must go through the canonical
      // anthropic client, which routes them via the official CLI proxy —
      // same seam chat and classify-with-llm use. Never Bearer-fetch them.
      if (rejectOAuth) return null;
      if (images && images.length > 0) {
        // The CLI proxy carries text prompts only; the direct HTTP path is
        // banned for this credential. Degrade rather than send a doomed 429.
        logger.warn("anthropic subscription auth cannot carry images; degrading to null");
        return null;
      }
      return callAnthropicViaCliProxy(apiKey, prompt, model, temperature, timeoutMs);
    }
    if (rejectOAuth && !apiKey.startsWith("sk-ant-api")) return null;
    const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": apiKey };
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

/** Single-shot completion over the canonical Anthropic client for
 *  subscription-style credentials. streamAnthropicResponse owns the
 *  CLI-proxy-vs-direct-HTTP decision, so this can never regress into a
 *  banned Bearer fetch. Pass the credential UNSTRIPPED — the client's own
 *  usesAnthropicSubscriptionAuth check needs the oauth:/cli shape intact. */
async function callAnthropicViaCliProxy(token: string, prompt: string, model: string, temperature: number, timeoutMs: number): Promise<string | null> {
  const ac = new AbortController();
  const abortTimer = setTimeout(() => ac.abort(), timeoutMs);
  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { streamAnthropicResponse } = await import("./anthropic-client/index.js");
    const run = (async () => {
      let acc = "";
      for await (const event of streamAnthropicResponse({
        token, model, temperature,
        messages: [{ role: "user", content: prompt } as never],
        systemPrompt: "", tools: [], signal: ac.signal,
      })) {
        // A transport error (e.g. CLI "Please run /login") means there is no
        // valid completion — never return the error text as a response.
        if (event.type === "error") throw new Error(event.error || "anthropic transport error");
        if (event.type === "text") acc += event.delta || "";
      }
      return acc || null;
    })().catch((e: Error) => {
      logger.warn(`anthropic (cli proxy) call threw: ${e.message}`);
      return null;
    });
    // The claude CLI doesn't reliably honor abort signals (cold spawns can
    // hang 30-60s past abort) — race a wallclock so the documented timeoutMs
    // holds no matter what the subprocess does.
    const wallclock = new Promise<null>((resolve) => {
      raceTimer = setTimeout(() => resolve(null), timeoutMs);
    });
    return await Promise.race([run, wallclock]);
  } catch (e) {
    logger.warn(`anthropic (cli proxy) call threw: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(abortTimer);
    if (raceTimer) clearTimeout(raceTimer);
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
  responseFormat?: ProviderRequest["responseFormat"],
): Promise<string | null> {
  try {
    const resolved = await resolveCredential(credentialProvider);
    if (!resolved) return null;
    const apiKey = resolved.credential;
    const send = (rf: ProviderRequest["responseFormat"]) =>
      fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, temperature, max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
          // Structured output on the OpenAI wire shape. Absent → the body is
          // byte-identical to before responseFormat existed.
          ...(rf
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: rf.name,
                    schema: rf.schema,
                    ...(rf.strict !== undefined ? { strict: rf.strict } : {}),
                  },
                },
              }
            : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    let res = await send(responseFormat);
    if (!res.ok && res.status === 400 && responseFormat) {
      // A 400 with response_format on board is very likely about it (param
      // unsupported, or the caller's schema). Structured output is documented
      // best-effort here, so surface the server's complaint and retry exactly
      // once without it — no persistent learning at this layer (the adapter
      // path owns that); second failure degrades to null as before.
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      logger.warn(`${label} HTTP 400 with response_format sent (${snippet}) — retrying once without structured output`);
      res = await send(undefined);
    }
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

function callOpenAI(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number, responseFormat?: ProviderRequest["responseFormat"]): Promise<string | null> {
  return callOpenAICompatible("openai", "openai", "https://api.openai.com/v1", prompt, model, temperature, maxTokens, timeoutMs, responseFormat);
}

function callXai(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number, responseFormat?: ProviderRequest["responseFormat"]): Promise<string | null> {
  // xAI exposes an OpenAI-compatible endpoint at api.x.ai/v1; the OpenAI body
  // works unchanged. Auth comes from env XAI_API_KEY or the secrets store (the
  // chat path stores it there). Without this, every background classifier
  // (identity-extract, claim-verify, intent-classifier, …) silently no-ops for
  // xAI users — classify-with-llm hits the xAI fallback that returns null
  // before reaching this dispatcher.
  return callOpenAICompatible("xai", "xai", "https://api.x.ai/v1", prompt, model, temperature, maxTokens, timeoutMs, responseFormat);
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
