/**
 * Anthropic CLI adapter — proxies through the official `claude` CLI for
 * subscription credentials (Max, OAuth, sk-ant-oat tokens).
 *
 * IMPORTANT: This is the ONLY allowed path for subscription auth as of
 * April 2026 — Anthropic blocks third-party SDK calls under subscription
 * tokens with a 429. Pay-as-you-go API keys (sk-ant-api03-*) should use
 * the AnthropicHttpAdapter instead. Routing decision lives in the
 * dispatcher (and matches the existing logic in stream.ts).
 *
 * Like the HTTP adapter, this is a thin wrapper around the existing
 * streamViaCliWithTools — preserves the OAuth + subprocess + MCP bridge
 * machinery untouched. Step 7 can collapse the wrapper if desired, but
 * the CLI proxy is the riskiest path so it stays delegated until the
 * registry-driven dispatcher is proven in production.
 */

import { BaseAdapter } from "../adapter/base-adapter.js";
import type { ProviderRequest, StreamChunk } from "../adapter/types.js";
import { streamViaCliWithTools } from "../../anthropic-client/stream-cli.js";

export class AnthropicCliAdapter extends BaseAdapter {
  readonly name = "anthropic-cli";

  async *stream(req: ProviderRequest): AsyncIterable<StreamChunk> {
    const inner = streamViaCliWithTools({
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
          yield { type: "mcp_activity", toolName: evt.name, arguments: evt.arguments };
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
          yield { type: "error", message: evt.error || "Unknown Anthropic CLI error" };
          return;
      }
    }
  }
}

export const anthropicCliAdapter = new AnthropicCliAdapter();
