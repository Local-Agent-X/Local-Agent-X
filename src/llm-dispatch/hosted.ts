/**
 * Hosted-provider leg of llm-dispatch: how to call Anthropic, OpenAI, xAI and
 * Codex for a short, single-shot completion.
 *
 * Split out of llm-dispatch.ts, same as ollama.ts before it.
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
import { anthropicThinkingOffMode, anthropicUsesAdaptiveThinking, normalizeAnthropicModel, planAnthropicReasoning, usesAnthropicSubscriptionAuth } from "../anthropic-models.js";
import { isMaxTokensRejection } from "../providers/adapters/openai-param-rejections.js";
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

/** `provider` is the picker entry the credential comes from: "anthropic" (the
 *  subscription sign-in) or "anthropic-api" (a key saved in LAX). Never
 *  cross-resolved — the entry the user picked is the one that is billed. */
export async function callAnthropic(provider: "anthropic" | "anthropic-api", prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number, rejectOAuth: boolean, images?: string[]): Promise<string | null> {
  try {
    const resolved = await resolveCredential(provider, { rejectOAuth });
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
      return callAnthropicViaCliProxy(apiKey, prompt, model, temperature, maxTokens, timeoutMs, images);
    }
    if (rejectOAuth && !apiKey.startsWith("sk-ant-api")) return null;
    // The raw wire only accepts runtime ids — aliases users actually have in
    // settings ("anthropic/…" prefixes, dotted versions, "[1m]" suffixes,
    // dated snapshots) 404. normalizeAnthropicModel is the one alias map (the
    // canonical client normalizes with it in stream-api.ts); "api" mode is
    // this path's auth mode. Runtime ids pass through byte-identical, and the
    // CLI-proxy leg above normalizes inside the client itself.
    const wireModel = normalizeAnthropicModel(model);
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
      body: JSON.stringify({ model: wireModel, max_tokens: maxTokens, ...(anthropicUsesAdaptiveThinking(wireModel) ? {} : { temperature }), ...shortAnswerShape(wireModel), messages: [{ role: "user", content }] }),
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

/**
 * A dispatch wants the answer, not a reasoning pass: thinking off in this model's
 * own off-shape, and low effort where thinking stays on (Fable 5 / Opus 5.5).
 * Omitting the field is not "off" on Opus 5 / Sonnet 5 (it runs adaptive), which
 * would spend an 80-token cap thinking. The same two rules stream-api.ts applies;
 * a legacy model (Haiku 4.5) gets nothing added, so its body is as before.
 */
function shortAnswerShape(wireModel: string): Record<string, unknown> {
  const plan = planAnthropicReasoning(wireModel, { effort: "low", disableThinking: true });
  return {
    ...(anthropicThinkingOffMode(wireModel) === "disabled-block" ? { thinking: { type: "disabled" } } : {}),
    ...(plan.effort ? { output_config: { effort: plan.effort } } : {}),
  };
}

/** Single-shot completion over the canonical Anthropic client for
 *  subscription-style credentials. streamAnthropicResponse owns the
 *  CLI-proxy-vs-direct-HTTP decision, so this can never regress into a
 *  banned Bearer fetch. Pass the credential UNSTRIPPED — the client's own
 *  usesAnthropicSubscriptionAuth check needs the oauth:/cli shape intact. */
async function callAnthropicViaCliProxy(token: string, prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number, images?: string[]): Promise<string | null> {
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
        // Without an explicit maxTokens the client defaults to the model's
        // full output budget (64k on Haiku) — dispatch callers pass tight
        // caps (200 for classifiers/rerank) and the subscription leg must
        // honor them the same as the raw leg's max_tokens.
        token, model, temperature, maxTokens,
        // The answer, not a reasoning pass (shortAnswerShape says why); the client
        // applies both per model.
        disableThinking: true, effort: "low",
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
  /** "none" asks a thinking model to answer without a reasoning pass. LM Studio
   *  honours it (qwen3.6-27b: 19 tokens in 0.5s instead of 80 tokens of thinking
   *  and an empty answer, 2026-10-18); chat_template_kwargs.enable_thinking it
   *  ignores. "low" is the least a hosted reasoning model (gpt-5.x, grok-4) takes,
   *  now a dispatch runs on the chat model. Absent → the body is byte-identical
   *  to before. */
  reasoningEffort?: "none" | "low",
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
    const send = (rf: ProviderRequest["responseFormat"], withMaxTokens = true) =>
      fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, temperature, ...(withMaxTokens ? { max_tokens: maxTokens } : {}),
          messages: [{ role: "user", content: userContent }],
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
    if (!res.ok && res.status === 400 && isMaxTokensRejection(await res.clone().text().catch(() => ""))) {
      // Newer OpenAI models take max_completion_tokens and 400 the whole request
      // on max_tokens. The cap is a guard rail, so retry once without it, as the
      // chat adapter does (providers/adapters/openai-http.ts).
      logger.info(`${label} ${model} rejected max_tokens — retrying once without it`);
      res = await send(responseFormat, false);
    }
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

export function callOpenAI(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number, images?: string[], responseFormat?: ProviderRequest["responseFormat"], reasoningEffort?: "low"): Promise<string | null> {
  return callOpenAICompatible("openai", "openai", "https://api.openai.com/v1", prompt, model, temperature, maxTokens, timeoutMs, responseFormat, undefined, images, reasoningEffort);
}

export function callXai(prompt: string, model: string, temperature: number, maxTokens: number, timeoutMs: number, images?: string[], responseFormat?: ProviderRequest["responseFormat"], reasoningEffort?: "low"): Promise<string | null> {
  // xAI exposes an OpenAI-compatible endpoint at api.x.ai/v1; the OpenAI body
  // works unchanged. Auth comes from env XAI_API_KEY or the secrets store (the
  // chat path stores it there). Without this, every background classifier
  // (identity-extract, claim-verify, intent-classifier, …) silently no-ops for
  // xAI users — classify-with-llm hits the xAI fallback that returns null
  // before reaching this dispatcher.
  return callOpenAICompatible("xai", "xai", "https://api.x.ai/v1", prompt, model, temperature, maxTokens, timeoutMs, responseFormat, undefined, images, reasoningEffort);
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
        // A short answer: the client's chat default "medium" is a reasoning pass
        // for nothing (the classifier's Codex leg says the same).
        reasoningEffort: "low",
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
