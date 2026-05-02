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
import { _localNoToolModels } from "../types.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("providers.adapters.openai-http");

const REASONING_CAPABLE = /grok-3-mini-reasoning|^o[134]|gpt-5|gemini-(2\.5|3)|deepseek-r1|qwen.*reasoning/i;

export class OpenAIHttpAdapter extends BaseAdapter {
  readonly name: string = "openai-http";

  async *stream(req: ProviderRequest): AsyncIterable<StreamChunk> {
    const client = new OpenAI({ apiKey: req.apiKey, baseURL: req.baseURL });
    const useTools = !_localNoToolModels.has(req.model);
    const reasoningCapable = REASONING_CAPABLE.test(req.model);

    let stream;
    try {
      stream = await client.chat.completions.create(
        {
          model: req.model,
          messages: [
            { role: "system", content: req.systemPrompt },
            ...req.messages,
          ],
          ...(useTools ? { tools: toOpenAITools(req.tools) } : {}),
          temperature: req.temperature ?? 0.7,
          stream: true,
          ...(reasoningCapable ? { reasoning_effort: "medium" as const } : {}),
        },
        { signal: req.signal || undefined },
      ).catch(async (err: Error) => {
        // "Does not support tools" fallback — some Ollama models (llama3,
        // qwen2, etc.) reject the `tools` field entirely. Trigger on the
        // error string regardless of baseURL: 127.0.0.1, localhost, custom
        // remote ollama, and any other OpenAI-compat provider with the
        // same constraint all benefit. Harmless for providers that DO
        // support tools — they never emit this error.
        if (err.message?.includes("does not support tools")) {
          _localNoToolModels.add(req.model);
          logger.info(`model ${req.model} doesn't support tools — switching to chat-only`);
          return client.chat.completions.create({
            model: req.model,
            messages: [
              { role: "system", content: req.systemPrompt },
              ...req.messages,
            ],
            temperature: req.temperature ?? 0.7,
            stream: true,
          }, { signal: req.signal || undefined });
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
