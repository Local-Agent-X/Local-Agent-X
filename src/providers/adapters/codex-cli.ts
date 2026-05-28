/**
 * Codex CLI adapter — wraps the Codex Responses API stream
 * (codex-client.streamCodexResponse). Subscription auth via JWT, separate
 * wire format from OpenAI Chat Completions (uses /v1/responses with
 * encrypted reasoning items and a `previousResponseId` chain).
 *
 * Reasoning items are forwarded as `reasoning` chunks (opaque payload).
 * The responseId is attached to the final `done` chunk so the caller
 * can thread it back via ProviderRequest.previousResponseId on the
 * next turn — keeps the encrypted reasoning chain alive without
 * resending it as plaintext.
 */

import { BaseAdapter } from "../adapter/base-adapter.js";
import type { ProviderRequest, StreamChunk } from "../adapter/types.js";
import { streamCodexResponse } from "../../codex-client/index.js";

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
        previousResponseId: req.previousResponseId,
        sessionId: req.sessionId,
        toolChoice: req.toolChoice,
        signal: req.signal,
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
            yield { type: "reasoning", item: evt.item };
            break;
          case "done":
            if (evt.usage) {
              yield {
                type: "usage",
                promptTokens: evt.usage.inputTokens,
                completionTokens: evt.usage.outputTokens,
              };
            }
            // Surface any reasoning the inner generator collected at
            // wrap-up time but didn't stream as a separate event.
            for (const item of evt.reasoning || []) {
              yield { type: "reasoning", item };
            }
            yield { type: "done", stopReason: "end_turn", responseId: evt.responseId };
            return;
        }
      }
    } catch (e) {
      yield { type: "error", message: (e as Error).message || "Codex stream error" };
    }
  }
}

export const codexCliAdapter = new CodexCliAdapter();
