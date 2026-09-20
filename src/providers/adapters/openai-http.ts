/**
 * OpenAI HTTP adapter — covers the OpenAI Chat Completions wire format.
 * Same shape used by xAI, Gemini's OpenAI-compat endpoint, and any other
 * OpenAI-compatible provider; the dispatcher passes a custom baseURL.
 *
 * Behavior preserved from the in-line streaming logic that lived in
 * run-standard.ts: tool-call delta accumulation by index, reasoning_effort
 * opt-in on capable models, abort handling, "model doesn't support tools"
 * fallback for local providers.
 */

import OpenAI, { type ClientOptions } from "openai";
import { BaseAdapter } from "../adapter/base-adapter.js";
import { LOCAL_DEFAULT_MAX_TOKENS, type ProviderRequest, type StreamChunk } from "../adapter/types.js";
import { toOpenAITools } from "../shared/tool-shape.js";
import { hasNoToolSupport, markNoToolSupport, hasParamUnsupported, markParamUnsupported } from "../types.js";
import { createLogger } from "../../logger.js";
import { PROVIDERS, isHttpProvider } from "../registry.js";
import { effortForChatCompletions, DEFAULT_REASONING_EFFORT } from "../reasoning-effort.js";
import { PROVIDER_IDS, type ProviderId } from "../provider-ids.js";
import { isLocalOnlyMode, isLoopbackUrl, isLoopbackOrPrivateUrl } from "../../local-only-policy.js";
import {
  isReasoningEffortRejection,
  isTemperatureRejection,
  isResponseFormatRejection,
  isMaxTokensRejection,
  isStreamOptionsRejection,
} from "./openai-param-rejections.js";

const logger = createLogger("providers.adapters.openai-http");

// Reasoning capability now lives per-provider on PROVIDERS[id].capabilities.reasoning
// (see src/providers/registry.ts). This adapter doesn't know which provider
// it's running for at call time — req.baseURL is the only hint — so we
// match by scanning the registry for any http provider whose baseURL
// matches and whose reasoning regex matches the model.
function isReasoningCapable(baseURL: string | undefined, model: string): boolean {
  if (!baseURL) return false;
  for (const id of PROVIDER_IDS) {
    const meta = PROVIDERS[id as ProviderId];
    if (!isHttpProvider(meta)) continue;
    const metaURL = typeof meta.baseURL === "string" ? meta.baseURL : null;
    if (metaURL && baseURL.startsWith(metaURL)) {
      return meta.capabilities.reasoning ? meta.capabilities.reasoning.test(model) : false;
    }
  }
  // Unknown baseURL (local ollama, custom, ollama-cloud) — fall back to
  // OSS-style reasoning models so deepseek-r1/qwen/gpt-oss still opt in.
  return /deepseek-r1|qwen.*reasoning|gpt-oss|glm-4\.7/i.test(model);
}

// Runaway guard rail for LOCAL endpoints — see the constant's doc in
// ../adapter/types.ts (declared there so the window-aware clamp in
// canonical-loop/adapters/openai-compat/local-cap.ts shares it without
// loading this module's SDK import). Re-exported for existing consumers.
export { LOCAL_DEFAULT_MAX_TOKENS } from "../adapter/types.js";

export function strictFetchFor(baseURL: string | undefined): ClientOptions["fetch"] {
  if (!isLocalOnlyMode() || !baseURL || !isLoopbackUrl(baseURL)) return undefined;
  return ((input: unknown, init?: unknown) => {
    const request = init as RequestInit;
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return fetch(input as Parameters<typeof fetch>[0], { ...request, headers, redirect: "manual" });
  }) as unknown as NonNullable<ClientOptions["fetch"]>;
}

export class OpenAIHttpAdapter extends BaseAdapter {
  readonly name: string = "openai-http";

  async *stream(req: ProviderRequest): AsyncIterable<StreamChunk> {
    const strictFetch = strictFetchFor(req.baseURL);
    const client = new OpenAI({ apiKey: req.apiKey, baseURL: req.baseURL, ...(strictFetch ? { fetch: strictFetch } : {}) });
    const useTools = !hasNoToolSupport(req.baseURL, req.model);
    const reasoningCapable =
      isReasoningCapable(req.baseURL, req.model) &&
      !hasParamUnsupported(req.baseURL, req.model, "reasoning_effort");
    // o-series models reject a non-default temperature; once we've learned a
    // (baseURL, model) does, omit the field up front so the first call skips
    // the failed round-trip.
    const temperatureAllowed = !hasParamUnsupported(req.baseURL, req.model, "temperature");
    const streamUsageAllowed = !hasParamUnsupported(req.baseURL, req.model, "stream_options");
    // Structured output only when the caller asked for it AND this
    // (baseURL, model) hasn't already rejected the param.
    const responseFormatAllowed =
      !!req.responseFormat && !hasParamUnsupported(req.baseURL, req.model, "response_format");
    // Output-token cap: explicit req.maxTokens wins on any endpoint; local
    // endpoints (loopback or private-range — LAN runtimes) fall back to the
    // runaway default unless the caller measured the window and found no
    // completion budget (omitDefaultMaxTokens — see local-cap.ts); cloud
    // endpoints get NO default. See LOCAL_DEFAULT_MAX_TOKENS for why.
    const resolvedMaxTokens =
      req.maxTokens ??
      (!req.omitDefaultMaxTokens && req.baseURL && isLoopbackOrPrivateUrl(req.baseURL)
        ? LOCAL_DEFAULT_MAX_TOKENS
        : undefined);
    const maxTokensAllowed =
      resolvedMaxTokens !== undefined && !hasParamUnsupported(req.baseURL, req.model, "max_tokens");

    // Translate canonical toolChoice → OpenAI Chat Completions tool_choice
    // shape. Only meaningful when we're shipping tools this turn.
    const openaiToolChoice = (() => {
      if (!useTools || !req.toolChoice) return undefined;
      if (req.toolChoice === "auto" || req.toolChoice === "required") return req.toolChoice;
      // { type: "tool", name } → OpenAI wants { type: "function", function: { name } }
      if (req.toolChoice.type === "tool" && req.toolChoice.name) {
        return { type: "function" as const, function: { name: req.toolChoice.name } };
      }
      return undefined;
    })();

    // Single source of truth for the create() body. Each retry branch flips
    // exactly one include-flag off rather than re-specifying the whole body,
    // so the params can't drift between the initial call and a self-heal.
    // When includeTemperature is false we OMIT the field entirely (the API
    // falls back to its own default) instead of sending a value.
    // The body of the attempt that went through, for the turn trace: after a
    // self-heal retry this is the RETRY's body, i.e. what the server accepted.
    let sentParams: Record<string, unknown> | null = null;
    const buildParams = (opts: {
      includeTools: boolean;
      includeReasoningEffort: boolean;
      includeTemperature: boolean;
      includeResponseFormat: boolean;
      includeMaxTokens: boolean;
      includeStreamUsage: boolean;
    }) => (sentParams = {
      model: req.model,
      messages: [
        { role: "system" as const, content: req.systemPrompt },
        ...req.messages,
      ],
      ...(opts.includeTools ? { tools: toOpenAITools(req.tools) } : {}),
      ...(opts.includeTools && openaiToolChoice ? { tool_choice: openaiToolChoice } : {}),
      ...(opts.includeTemperature ? { temperature: req.temperature ?? 0.7 } : {}),
      ...(opts.includeMaxTokens && resolvedMaxTokens !== undefined
        ? { max_tokens: resolvedMaxTokens }
        : {}),
      stream: true as const,
      ...(opts.includeStreamUsage ? { stream_options: { include_usage: true } } : {}),
      // Cast: the installed SDK's ReasoningEffort union predates "minimal",
      // which the API accepts on gpt-5-class models.
      ...(opts.includeReasoningEffort
        ? { reasoning_effort: effortForChatCompletions(req.reasoningEffort ?? DEFAULT_REASONING_EFFORT) as "low" | "medium" | "high" }
        : {}),
      // OpenAI structured-output wire shape. Guarded by responseFormatAllowed,
      // so req.responseFormat is always set when this branch is included.
      ...(opts.includeResponseFormat && req.responseFormat
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: req.responseFormat.name,
                schema: req.responseFormat.schema,
                ...(req.responseFormat.strict !== undefined ? { strict: req.responseFormat.strict } : {}),
              },
            },
          }
        : {}),
    });

    const startedAt = Date.now();
    let stream;
    try {
      stream = await client.chat.completions.create(
        buildParams({
          includeTools: useTools,
          includeReasoningEffort: reasoningCapable,
          includeTemperature: temperatureAllowed,
          includeResponseFormat: responseFormatAllowed,
          includeMaxTokens: maxTokensAllowed,
          includeStreamUsage: streamUsageAllowed,
        }),
        { signal: req.signal || undefined },
      ).catch(async (err: Error) => {
        // Same-provider self-heal: when a 400 names exactly one param we sent,
        // remember it so the next call skips the param, then retry THIS call
        // once with that single knob turned off (everything else unchanged).
        // Only one retry — if the retried call 400s on a different param, that
        // error propagates, same as before. Every unrelated error re-throws.
        const retry = (opts: {
          includeTools: boolean;
          includeReasoningEffort: boolean;
          includeTemperature: boolean;
          includeResponseFormat: boolean;
          includeMaxTokens: boolean;
          includeStreamUsage: boolean;
        }) =>
          client.chat.completions.create(buildParams(opts), { signal: req.signal || undefined });

        // "Does not support tools" — some Ollama models (llama3, qwen2, etc.)
        // reject the `tools` field entirely. Trigger on the error string
        // regardless of baseURL; harmless for providers that DO support tools
        // (they never emit it). Chat-only retry also drops tool_choice.
        if (useTools && err.message?.includes("does not support tools")) {
          markNoToolSupport(req.baseURL, req.model);
          logger.info(`model ${req.model} doesn't support tools — switching to chat-only`);
          return retry({
            includeTools: false,
            includeReasoningEffort: reasoningCapable,
            includeTemperature: temperatureAllowed,
            includeResponseFormat: responseFormatAllowed,
            includeMaxTokens: maxTokensAllowed,
            includeStreamUsage: streamUsageAllowed,
          });
        }
        // reasoning_effort 400 — only when WE sent the param and the server
        // named that exact parameter.
        if (reasoningCapable && isReasoningEffortRejection(err.message)) {
          markParamUnsupported(req.baseURL, req.model, "reasoning_effort");
          logger.info(`model ${req.model} rejected reasoning_effort — retrying without it`);
          return retry({
            includeTools: useTools,
            includeReasoningEffort: false,
            includeTemperature: temperatureAllowed,
            includeResponseFormat: responseFormatAllowed,
            includeMaxTokens: maxTokensAllowed,
            includeStreamUsage: streamUsageAllowed,
          });
        }
        // temperature 400 — o-series models reject a non-default temperature.
        // Only when WE actually sent it; retry omitting the field.
        if (temperatureAllowed && isTemperatureRejection(err.message)) {
          markParamUnsupported(req.baseURL, req.model, "temperature");
          logger.info(`model ${req.model} rejected temperature — retrying without it`);
          return retry({
            includeTools: useTools,
            includeReasoningEffort: reasoningCapable,
            includeTemperature: false,
            includeResponseFormat: responseFormatAllowed,
            includeMaxTokens: maxTokensAllowed,
            includeStreamUsage: streamUsageAllowed,
          });
        }
        // response_format 400 — some OpenAI-compatible servers don't support
        // the json_schema wire param. Only when WE actually sent it AND the
        // server said "not supported" (schema-validation 400s fall through
        // and propagate — see isResponseFormatRejection). Structured output
        // is best-effort by contract, so retry omitting the field.
        if (responseFormatAllowed && isResponseFormatRejection(err.message)) {
          markParamUnsupported(req.baseURL, req.model, "response_format");
          logger.warn(`model ${req.model} rejected response_format — retrying without structured output`);
          return retry({
            includeTools: useTools,
            includeReasoningEffort: reasoningCapable,
            includeTemperature: temperatureAllowed,
            includeResponseFormat: false,
            includeMaxTokens: maxTokensAllowed,
            includeStreamUsage: streamUsageAllowed,
          });
        }
        // max_tokens 400 — the cap is a best-effort guard rail, so when a
        // server names the param as UNSUPPORTED (o-series wants
        // max_completion_tokens; some strict compat servers implement
        // neither), drop it and retry once. Value errors ("too large")
        // propagate — see isMaxTokensRejection.
        if (maxTokensAllowed && isMaxTokensRejection(err.message)) {
          markParamUnsupported(req.baseURL, req.model, "max_tokens");
          logger.info(`model ${req.model} rejected max_tokens — retrying without it`);
          return retry({
            includeTools: useTools,
            includeReasoningEffort: reasoningCapable,
            includeTemperature: temperatureAllowed,
            includeResponseFormat: responseFormatAllowed,
            includeMaxTokens: false,
            includeStreamUsage: streamUsageAllowed,
          });
        }
        // stream_options 400 — a strict OpenAI-compatible server that does not
        // implement the param. Usage is telemetry, never behaviour, so drop it
        // and retry once; the learned store keeps it off for this (baseURL,
        // model) afterwards.
        if (streamUsageAllowed && isStreamOptionsRejection(err.message)) {
          markParamUnsupported(req.baseURL, req.model, "stream_options");
          logger.info(`model ${req.model} rejected stream_options — retrying without usage reporting`);
          return retry({
            includeTools: useTools,
            includeReasoningEffort: reasoningCapable,
            includeTemperature: temperatureAllowed,
            includeResponseFormat: responseFormatAllowed,
            includeMaxTokens: maxTokensAllowed,
            includeStreamUsage: false,
          });
        }
        throw err;
      });
    } catch (e) {
      yield { type: "error", message: (e as Error).message || "OpenAI stream error" };
      return;
    }

    if (sentParams) {
      const { messages: _messages, tools, response_format, ...rest } = sentParams as Record<string, unknown> & {
        tools?: Array<{ function?: { name?: string } }>;
        response_format?: { json_schema?: { name?: string } };
      };
      yield {
        type: "request_sent",
        params: {
          ...rest,
          ...(tools ? { tools: tools.map((t) => t.function?.name ?? "?") } : {}),
          ...(response_format ? { response_format: response_format.json_schema?.name ?? "json_schema" } : {}),
        },
      };
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let firstTokenMs: number | undefined;
    let stopReason = "end_turn";
    const toolBuf: { id: string; name: string; arguments: string }[] = [];

    try {
      for await (const chunk of stream) {
        if (req.signal?.aborted) {
          stream.controller.abort();
          stopReason = "abort";
          break;
        }
        const choice = chunk.choices[0];
        if (choice?.finish_reason) stopReason = choice.finish_reason;
        // Usage rides its own trailing chunk (choices: []) when
        // stream_options.include_usage is set — read it before the no-delta
        // `continue` below, which would otherwise drop it.
        if (chunk.usage) {
          promptTokens += chunk.usage.prompt_tokens || 0;
          completionTokens += chunk.usage.completion_tokens || 0;
          cachedTokens += chunk.usage.prompt_tokens_details?.cached_tokens || 0;
        }
        const delta = choice?.delta;
        if (!delta) continue;

        // Reasoning models (Cerebras gpt-oss/glm/qwen, DeepSeek R1, etc.)
        // stream their chain-of-thought in a separate delta field —
        // `reasoning` on Cerebras, `reasoning_content` on DeepSeek-style.
        const deltaExt = delta as { reasoning?: string; reasoning_content?: string };
        const reasoningDelta = deltaExt.reasoning ?? deltaExt.reasoning_content;
        // Time-to-first-token: the first delta that carries anything the model
        // produced. Prompt processing ends here, so on a local runtime this is
        // the prefill cost of THIS request (a cache hit is tens of ms, a cold
        // prefix is seconds).
        if (firstTokenMs === undefined && (delta.content || delta.tool_calls || reasoningDelta)) {
          firstTokenMs = Date.now() - startedAt;
        }

        if (delta.content) {
          yield { type: "text", delta: delta.content };
        }

        // Surface reasoning as `thinking` so callers can render it distinct
        // from the final answer (or fall back to showing it as content when
        // no final answer ever lands).
        if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
          yield { type: "thinking", delta: reasoningDelta };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index === undefined) continue;
            while (toolBuf.length <= tc.index) {
              toolBuf.push({ id: "", name: "", arguments: "" });
            }
            if (tc.id) toolBuf[tc.index].id = tc.id;
            if (tc.function?.name) toolBuf[tc.index].name = tc.function.name;
            if (tc.function?.arguments) toolBuf[tc.index].arguments += tc.function.arguments;
          }
        }
      }
    } catch (e) {
      yield { type: "error", message: (e as Error).message || "OpenAI stream error" };
      return;
    }

    for (const tc of toolBuf) {
      if (tc.id || tc.name) {
        yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments };
      }
    }

    if (promptTokens || completionTokens) {
      yield { type: "usage", promptTokens, completionTokens, cachedTokens };
    }
    yield { type: "done", stopReason, ...(firstTokenMs !== undefined ? { firstTokenMs } : {}) };
  }
}

export const openaiHttpAdapter = new OpenAIHttpAdapter();
