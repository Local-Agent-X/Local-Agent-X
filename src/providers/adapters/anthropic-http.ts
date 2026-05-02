/**
 * Anthropic HTTP adapter — direct fetch to api.anthropic.com using a real
 * pay-as-you-go API key (sk-ant-api03-*). Subscription credentials
 * (Max/CLI/OAuth) MUST go through the CLI proxy adapter instead.
 *
 * For step 3 of the provider refactor, this is a thin wrapper around the
 * existing streamViaAPI in src/anthropic-client/stream-api.ts. The shape
 * translation (StreamEvent → StreamChunk) lives here; the actual SSE +
 * tool_use block parsing stays where it was tested.
 *
 * When step 7 (delete dead paths) lands, the body of streamViaAPI can
 * move directly into this adapter — but only after all callers have
 * migrated through the registry.
 */

import { BaseAdapter } from "../adapter/base-adapter.js";
import type { ProviderRequest, StreamChunk } from "../adapter/types.js";
import { streamViaAPI } from "../../anthropic-client/stream-api.js";

export class AnthropicHttpAdapter extends BaseAdapter {
  readonly name = "anthropic-http";

  async *stream(req: ProviderRequest): AsyncIterable<StreamChunk> {
    const inner = streamViaAPI({
      token: req.apiKey,
      model: req.model,
      messages: req.messages,
      systemPrompt: req.systemPrompt,
      tools: req.tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      toolChoice: req.toolChoice,
      sessionId: req.sessionId,
      signal: req.signal,
    });

    for await (const evt of inner) {
      if (req.signal?.aborted) {
        yield { type: "done", stopReason: "abort" };
        return;
      }

      switch (evt.type) {
        case "text":
          if (evt.delta) yield { type: "text", delta: evt.delta };
          break;
        case "tool_call":
          yield {
            type: "tool_call",
            id: evt.id || "",
            name: evt.name || "",
            arguments: evt.arguments || "",
          };
          break;
        case "mcp_activity":
          yield { type: "mcp_activity", toolName: evt.name };
          break;
        case "done":
          if (evt.usage) {
            yield {
              type: "usage",
              promptTokens: evt.usage.inputTokens,
              completionTokens: evt.usage.outputTokens,
            };
          }
          yield { type: "done", stopReason: evt.stopReason || "end_turn" };
          return;
        case "error":
          yield { type: "error", message: evt.error || "Unknown Anthropic HTTP error" };
          return;
      }
    }
  }
}

export const anthropicHttpAdapter = new AnthropicHttpAdapter();
