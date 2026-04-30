import { buildAnthropicRateLimitHint, normalizeAnthropicModel } from "../anthropic-models.js";
import { API_BASE, convertMessages } from "./request.js";
import type { StreamEvent, StreamOptions } from "./types.js";

export async function* streamViaAPI(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { token, model, messages, systemPrompt, tools, temperature = 1, maxTokens = 8192, toolChoice } = options;
  const resolvedModel = normalizeAnthropicModel(model, "api");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": token,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "interleaved-thinking-2025-05-14",
  };

  const body: Record<string, unknown> = {
    model: resolvedModel,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: convertMessages(messages),
    stream: true,
    // Extended thinking: lets the model reason about blockers before acting.
    // Turns "browser failed, retry?" into "the account picker popup is blocking
    // me — ask the user to click it manually, then I'll resume." Anthropic
    // requires temperature: 1 when thinking is enabled.
    thinking: { type: "enabled", budget_tokens: 3000 },
    temperature: 1,
  };

  const anthropicTools = tools?.map(t => ({
    name: t.name, description: t.description, input_schema: t.parameters,
  }));
  if (anthropicTools?.length) {
    body.tools = anthropicTools;
    if (toolChoice === "required") body.tool_choice = { type: "any" };
  }

  try {
    const response = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const hint = buildAnthropicRateLimitHint(response.status, token);
      yield { type: "error", error: `Anthropic ${response.status}: ${errorText.slice(0, 500)}${hint}` };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentToolId = "";
    let currentToolName = "";
    let currentToolArgs = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    let sawText = false, sawToolCall = false;
    let responseText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(data); } catch { continue; }

          const eventType = parsed.type as string;
          if (eventType === "message_start") {
            const usage = (parsed.message as Record<string, unknown>)?.usage as Record<string, number>;
            if (usage) inputTokens = usage.input_tokens || 0;
          } else if (eventType === "content_block_start") {
            const block = parsed.content_block as Record<string, unknown>;
            if (block?.type === "tool_use") {
              currentToolId = block.id as string;
              currentToolName = block.name as string;
              currentToolArgs = "";
            }
          } else if (eventType === "content_block_delta") {
            const delta = parsed.delta as Record<string, unknown>;
            if (delta?.type === "text_delta") { sawText = true; const t = delta.text as string; responseText += t; yield { type: "text", delta: t }; }
            else if (delta?.type === "input_json_delta") currentToolArgs += delta.partial_json as string;
          } else if (eventType === "content_block_stop") {
            if (currentToolId) {
              sawToolCall = true;
              yield { type: "tool_call", id: currentToolId, name: currentToolName, arguments: currentToolArgs };
              currentToolId = ""; currentToolName = ""; currentToolArgs = "";
            }
          } else if (eventType === "message_delta") {
            const usage = parsed.usage as Record<string, number>;
            if (usage) outputTokens = usage.output_tokens || 0;
            const delta = parsed.delta as Record<string, unknown>;
            if (delta?.stop_reason) stopReason = delta.stop_reason as string;
          }
        }
      }
    }

    const { classifyAnthropicResponse, logClassification } = await import("../response-classifier.js");
    const classification = classifyAnthropicResponse({
      hasText: sawText, hasToolCalls: sawToolCall, stopReason, inputTokens, outputTokens, responseText,
    });
    logClassification("anthropic", resolvedModel, classification);
    yield { type: "done", usage: { inputTokens, outputTokens }, stopReason, classification };
  } catch (e) {
    yield { type: "error", error: `Anthropic error: ${(e as Error).message?.slice(0, 300)}` };
  }
}
