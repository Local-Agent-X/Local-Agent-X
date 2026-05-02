/**
 * Codex CLI adapter — wraps the Codex Responses API stream
 * (codex-client.streamCodexResponse). Subscription auth via JWT, separate
 * wire format from OpenAI Chat Completions (uses /v1/responses with
 * encrypted reasoning items and a `previousResponseId` chain).
 *
 * Reasoning items are not part of the StreamChunk vocabulary — the
 * dispatcher (which still owns the loop) needs them for chain
 * continuation. For now this adapter discards them; a follow-up will
 * thread reasoning through ProviderRequest/Response so the loop can
 * pass `previousResponseId` between iterations without bypassing the
 * adapter contract.
 */

import { BaseAdapter } from "../adapter/base-adapter.js";
import type { ProviderRequest, StreamChunk } from "../adapter/types.js";
import { streamCodexResponse } from "../../codex-client.js";

export class CodexCliAdapter extends BaseAdapter {
  readonly name = "codex-cli";

  async *stream(req: ProviderRequest): AsyncIterable<StreamChunk> {
    const codexTools = req.tools.map(t => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    let inner;
    try {
      inner = streamCodexResponse({
        token: req.apiKey,
        model: req.model,
        messages: req.messages,
        systemPrompt: req.systemPrompt,
        tools: codexTools,
        temperature: req.temperature,
        sessionId: req.sessionId,
        toolChoice: req.toolChoice,
      });
    } catch (e) {
      yield { type: "error", message: (e as Error).message || "Codex stream error" };
      return;
    }

    try {
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
              id: evt.id,
              name: evt.name,
              arguments: evt.arguments,
            };
            break;
          case "reasoning":
            // Reasoning items kept inside the inner generator's done payload;
            // dispatcher pulls them via the existing run-http path until
            // ProviderRequest grows a reasoning channel.
            break;
          case "done":
            if (evt.usage) {
              yield {
                type: "usage",
                promptTokens: evt.usage.inputTokens,
                completionTokens: evt.usage.outputTokens,
              };
            }
            yield { type: "done", stopReason: "end_turn" };
            return;
        }
      }
    } catch (e) {
      yield { type: "error", message: (e as Error).message || "Codex stream error" };
    }
  }
}

export const codexCliAdapter = new CodexCliAdapter();
