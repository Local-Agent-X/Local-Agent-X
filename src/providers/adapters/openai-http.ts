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

import OpenAI from "openai";
import { BaseAdapter } from "../adapter/base-adapter.js";
import type { ProviderRequest, StreamChunk } from "../adapter/types.js";
import { toOpenAITools } from "../shared/tool-shape.js";
import { hasNoToolSupport, markNoToolSupport, hasParamUnsupported, markParamUnsupported } from "../types.js";
import { createLogger } from "../../logger.js";
import { PROVIDERS, isHttpProvider } from "../registry.js";
import { PROVIDER_IDS, type ProviderId } from "../provider-ids.js";

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

// Some models named as reasoners still 400 the whole request on the
// `reasoning_effort` param (grok-4.20-0309-reasoning is the live case:
// "does not support parameter reasoningEffort"). Match that specific
// rejection — and only that — so the catch strips reasoning_effort and
// retries, while every other 400 (rate limit, context length, auth) still
// propagates untouched.
export function isReasoningEffortRejection(message: string | undefined): boolean {
  return /does not support parameter\s+reasoning_?effort/i.test(message ?? "");
}

// o1/o3/o-series models 400 the whole request on a non-default `temperature`
// ("Unsupported value: 'temperature' does not support 0.7 with this model.
// Only the default (1) value is supported."). Match that specific rejection —
// and only that — so the catch drops the temperature field (letting the API
// use its default) and retries, while every other 400 still propagates.
export function isTemperatureRejection(message: string | undefined): boolean {
  return /unsupported value:\s*'?temperature|temperature.*only the default|does not support.*temperature/i.test(
    message ?? "",
  );
}

export class OpenAIHttpAdapter extends BaseAdapter {
  readonly name: string = "openai-http";

  async *stream(req: ProviderRequest): AsyncIterable<StreamChunk> {
    const client = new OpenAI({ apiKey: req.apiKey, baseURL: req.baseURL });
    const useTools = !hasNoToolSupport(req.baseURL, req.model);
    const reasoningCapable =
      isReasoningCapable(req.baseURL, req.model) &&
      !hasParamUnsupported(req.baseURL, req.model, "reasoning_effort");
    // o-series models reject a non-default temperature; once we've learned a
    // (baseURL, model) does, omit the field up front so the first call skips
    // the failed round-trip.
    const temperatureAllowed = !hasParamUnsupported(req.baseURL, req.model, "temperature");

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
    const buildParams = (opts: {
      includeTools: boolean;
      includeReasoningEffort: boolean;
      includeTemperature: boolean;
    }) => ({
      model: req.model,
      messages: [
        { role: "system" as const, content: req.systemPrompt },
        ...req.messages,
      ],
      ...(opts.includeTools ? { tools: toOpenAITools(req.tools) } : {}),
      ...(opts.includeTools && openaiToolChoice ? { tool_choice: openaiToolChoice } : {}),
      ...(opts.includeTemperature ? { temperature: req.temperature ?? 0.7 } : {}),
      stream: true as const,
      ...(opts.includeReasoningEffort ? { reasoning_effort: "medium" as const } : {}),
    });

    let stream;
    try {
      stream = await client.chat.completions.create(
        buildParams({
          includeTools: useTools,
          includeReasoningEffort: reasoningCapable,
          includeTemperature: temperatureAllowed,
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
          });
        }
        throw err;
      });
    } catch (e) {
      yield { type: "error", message: (e as Error).message || "OpenAI stream error" };
      return;
    }

    let promptTokens = 0;
    let completionTokens = 0;
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
        const delta = choice?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: "text", delta: delta.content };
        }

        // Reasoning models (Cerebras gpt-oss/glm/qwen, DeepSeek R1, etc.)
        // stream their chain-of-thought in a separate delta field —
        // `reasoning` on Cerebras, `reasoning_content` on DeepSeek-style.
        // Surface as `thinking` so callers can render it distinct from
        // the final answer (or fall back to showing it as content when
        // no final answer ever lands).
        const deltaExt = delta as { reasoning?: string; reasoning_content?: string };
        const reasoningDelta = deltaExt.reasoning ?? deltaExt.reasoning_content;
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

        if (chunk.usage) {
          promptTokens += chunk.usage.prompt_tokens || 0;
          completionTokens += chunk.usage.completion_tokens || 0;
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
      yield { type: "usage", promptTokens, completionTokens };
    }
    yield { type: "done", stopReason };
  }
}

export const openaiHttpAdapter = new OpenAIHttpAdapter();
