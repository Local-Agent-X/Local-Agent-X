import { buildAnthropicRateLimitHint, normalizeAnthropicModel } from "../anthropic-models.js";
import { API_BASE, convertMessages } from "./request.js";
import type { StreamEvent, StreamOptions } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("anthropic-client.stream-oauth");

/** Direct Anthropic request with subscription auth — keep OAuth beta, avoid Claude Code identity spoofing. */
export async function* streamViaOAuthSDK(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { token, model, messages, systemPrompt, tools, temperature = 1, maxTokens = 8192 } = options;
  const resolvedModel = normalizeAnthropicModel(model, "subscription");

  const anthropicTools = tools?.map(t => ({
    name: t.name, description: t.description, input_schema: t.parameters,
  }));

  const body: Record<string, unknown> = {
    model: resolvedModel,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: convertMessages(messages),
    stream: true,
    temperature,
  };
  if (anthropicTools?.length) body.tools = anthropicTools;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "user-agent": "open-agent-x/0.1",
    "accept": "application/json",
  };

  if (resolvedModel !== model) {
    logger.info(`[anthropic] Normalized subscription model ${model} -> ${resolvedModel}`);
  }
  logger.info("[anthropic] Using direct subscription-auth messages API");

  try {
    const response = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[anthropic] OAuth SDK error ${response.status}:`, errorText.slice(0, 200));
      const hint = buildAnthropicRateLimitHint(response.status, token);
      yield { type: "error", error: `Anthropic ${response.status}: ${errorText.slice(0, 500)}${hint}` };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }

    // Parse SSE stream — same as streamViaAPI
    const reader = response.body?.getReader();
    if (!reader) { yield { type: "error", error: "No response body" }; yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } }; return; }

    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0, outputTokens = 0;
    let currentToolId = "", currentToolName = "", currentToolArgs = "";
    let stopReason: string | undefined;
    let sawText = false, sawToolCall = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);

          if (event.type === "message_start" && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || 0;
          }

          if (event.type === "content_block_start") {
            if (event.content_block?.type === "tool_use") {
              currentToolId = event.content_block.id || "";
              currentToolName = event.content_block.name || "";
              currentToolArgs = "";
            }
          }

          if (event.type === "content_block_delta") {
            if (event.delta?.type === "text_delta") {
              sawText = true;
              yield { type: "text", delta: event.delta.text || "" };
            }
            if (event.delta?.type === "input_json_delta") {
              currentToolArgs += event.delta.partial_json || "";
            }
          }

          if (event.type === "content_block_stop" && currentToolId) {
            sawToolCall = true;
            yield { type: "tool_call", id: currentToolId, name: currentToolName, arguments: currentToolArgs };
            currentToolId = "";
          }

          if (event.type === "message_delta") {
            if (event.usage) outputTokens = event.usage.output_tokens || 0;
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          }

          if (event.type === "message_stop") {
            const { classifyAnthropicResponse, logClassification } = await import("../response-classifier.js");
            const classification = classifyAnthropicResponse({
              hasText: sawText, hasToolCalls: sawToolCall, stopReason,
              inputTokens, outputTokens,
            });
            logClassification("anthropic", "api", classification);
            yield { type: "done", usage: { inputTokens, outputTokens }, stopReason, classification };
          }
        } catch {}
      }
    }
  } catch (e) {
    const msg = (e as Error).message || "unknown";
    logger.error(`[anthropic] streamViaOAuthSDK exception: ${msg.slice(0, 300)}`);
    yield { type: "error", error: msg };
    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
