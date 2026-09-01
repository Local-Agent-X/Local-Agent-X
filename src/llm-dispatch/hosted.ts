/**
 * Hosted-provider leg of llm-dispatch: how to call Anthropic, OpenAI, xAI and
 * Codex for a short, single-shot completion.
 *
 * Split out of llm-dispatch.ts (400-LOC gate), same as ollama.ts before it.
 * Cohesive on its own: llm-dispatch.ts decides WHICH provider and WHICH model,
 * this file knows how each provider's wire actually works — credential
 * resolution, request shape, vision content blocks, error handling. The seam is
 * one-way: llm-dispatch.ts imports these, nothing here imports back.
 *
 * Every function keeps the module's contract — returns `null` on any failure
 * (network, auth, non-OK HTTP, parse error), never throws.
 *
 * Anthropic subscription credentials (cli sentinel / oauth: / sk-ant-oat) are
 * NEVER sent over direct HTTP — that path is banned (429 since April 2026) and
 * callAnthropic routes them through the canonical client instead.
 */

import { resolveCredential } from "../auth/resolve.js";
import { anthropicUsesAdaptiveThinking, usesAnthropicSubscriptionAuth } from "../anthropic-models.js";
import type { ProviderId } from "../providers/provider-ids.js";
import type { ProviderRequest } from "../providers/adapter/types.js";
import { createLogger } from "../logger.js";

// Same channel name as llm-dispatch.ts: these lines were emitted under
// "[llm-dispatch]" before the split and callers grep for them.
const logger = createLogger("llm-dispatch");

// Anthropic Messages API user-content shape: a bare string, or content blocks
// when images ride along (images precede the text so the model reads the
// question with the pixels already in context).
type AnthropicUserContent =
  | string
  | Array<
      | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
      | { type: "text"; text: string }
    >;

export async function callAnthropic(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number, rejectOAuth: boolean, images?: string[]): Promise<string | null> {
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
      // Images ride the CLI-proxy path too: streamAnthropicResponse's
      // convertUserContent turns image_url parts into Anthropic image blocks and
      // the OAuth/Claude-Code-identity request carries them (chat vision uses the
      // very same seam). Previously degraded to null on the mistaken belief the
      // proxy was text-only — that dropped every Claude-on-subscription vision
      // check (the build design judge included).
      return callAnthropicViaCliProxy(apiKey, prompt, model, temperature, timeoutMs, images);
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
      // Fable 5 / Opus 5 / Opus 4.7+ / Sonnet 5 reject `temperature` with a 400
      // ("`temperature` is deprecated for this model"), which nulled every
      // API-key classifier call against them. anthropicUsesAdaptiveThinking is
      // the one source of truth for "this model rejects sampling params" — the
      // same predicate the CLI-proxy leg gates on in stream-api.ts, and it
      // resolves aliases itself (api mode, which is this path's auth mode).
      // Legacy models keep the byte-identical body, key order included.
      body: JSON.stringify({ model, max_tokens: maxTokens, ...(anthropicUsesAdaptiveThinking(model) ? {} : { temperature }), messages: [{ role: "user", content }] }),
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
async function callAnthropicViaCliProxy(token: string, prompt: string, model: string, temperature: number, timeoutMs: number, images?: string[]): Promise<string | null> {
  const ac = new AbortController();
  const abortTimer = setTimeout(() => ac.abort(), timeoutMs);
  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { streamAnthropicResponse } = await import("../anthropic-client/index.js");
    // OpenAI-style image_url parts; convertUserContent (anthropic-client) maps
    // them to Anthropic image blocks. No images → bare string, byte-identical.
    const content = images && images.length > 0
      ? [
          ...images.map((data) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } })),
          { type: "text", text: prompt },
        ]
      : prompt;
    const run = (async () => {
      let acc = "";
      for await (const event of streamAnthropicResponse({
        token, model, temperature,
        messages: [{ role: "user", content } as never],
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
export async function callOpenAICompatible(
  label: string,
  credentialProvider: ProviderId | null,
  baseURL: string,
  prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number,
  responseFormat?: ProviderRequest["responseFormat"],
  explicitApiKey?: string,
  images?: string[],
): Promise<string | null> {
  try {
    const resolved = credentialProvider ? await resolveCredential(credentialProvider) : null;
    const apiKey = explicitApiKey ?? resolved?.credential;
    if (!apiKey) return null;
    // Vision on the OpenAI wire shape: base64 image_url content blocks precede
    // the text (mirroring the Anthropic path). No images → content stays the bare
    // prompt string, so text dispatches produce a byte-identical body.
    const userContent = images && images.length > 0
      ? [
          ...images.map((data) => ({ type: "image_url" as const, image_url: { url: `data:image/png;base64,${data}` } })),
          { type: "text" as const, text: prompt },
        ]
      : prompt;
    const send = (rf: ProviderRequest["responseFormat"]) =>
      fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, temperature, max_tokens: maxTokens,
          messages: [{ role: "user", content: userContent }],
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
        ...(credentialProvider === null ? { redirect: "manual" as const } : {}),
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

export function callOpenAI(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number, images?: string[], responseFormat?: ProviderRequest["responseFormat"]): Promise<string | null> {
  return callOpenAICompatible("openai", "openai", "https://api.openai.com/v1", prompt, model, temperature, maxTokens, timeoutMs, responseFormat, undefined, images);
}

export function callXai(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number, images?: string[], responseFormat?: ProviderRequest["responseFormat"]): Promise<string | null> {
  // xAI exposes an OpenAI-compatible endpoint at api.x.ai/v1; the OpenAI body
  // works unchanged. Auth comes from env XAI_API_KEY or the secrets store (the
  // chat path stores it there). Without this, every background classifier
  // (identity-extract, claim-verify, intent-classifier, …) silently no-ops for
  // xAI users — classify-with-llm hits the xAI fallback that returns null
  // before reaching this dispatcher.
  return callOpenAICompatible("xai", "xai", "https://api.x.ai/v1", prompt, model, temperature, maxTokens, timeoutMs, responseFormat, undefined, images);
}

export async function callCodex(prompt: string, model: string, temperature: number, timeoutMs: number, images?: string[]): Promise<string | null> {
  // Codex is a ChatGPT-subscription OAuth token, not an API key — it goes
  // through the canonical streaming client (the same one chat and
  // classify-with-llm use), not a raw fetch. Accumulate the streamed text into
  // a single completion. maxTokens has no equivalent here; extraction/vision
  // outputs are short, so we read the stream to completion.
  try {
    const resolved = await resolveCredential("codex");
    if (!resolved) return null;
    const { streamCodexResponse } = await import("../codex-client/index.js");
    // OpenAI-style image_url parts; convertMessagesToInput (codex-message-convert)
    // maps them to the Responses-API `input_image` shape the codex endpoint reads.
    const content = images && images.length > 0
      ? [
          ...images.map((data) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } })),
          { type: "text", text: prompt },
        ]
      : prompt;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      let acc = "";
      for await (const event of streamCodexResponse({
        token: resolved.credential, model, temperature,
        messages: [{ role: "user", content } as never],
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
