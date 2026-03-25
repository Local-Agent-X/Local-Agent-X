/**
 * Anthropic Messages API streaming client.
 *
 * Streams responses from Claude models via the Anthropic Messages API.
 * Supports tool use (function calling) in the same format as OpenAI.
 *
 * Uses OAuth access token or API key as Bearer auth.
 * Special headers for OAuth tokens (claude-code compatibility).
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface StreamEvent {
  type: "text" | "tool_call" | "done" | "error";
  delta?: string;
  id?: string;
  name?: string;
  arguments?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

interface StreamOptions {
  token: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  systemPrompt: string;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  temperature?: number;
  maxTokens?: number;
}

/** Convert OpenAI-format messages to Anthropic format */
function convertMessages(messages: ChatCompletionMessageParam[]): unknown[] {
  const result: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // System prompt handled separately

    if (msg.role === "user") {
      result.push({
        role: "user",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    } else if (msg.role === "assistant") {
      const m = msg as Record<string, unknown>;
      const content: unknown[] = [];

      if (typeof m.content === "string" && m.content) {
        content.push({ type: "text", text: m.content });
      }

      // Tool calls → tool_use blocks
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.function.arguments); } catch {}
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }

      if (content.length > 0) {
        result.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool") {
      const m = msg as { tool_call_id: string; content: string };
      result.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: m.content,
        }],
      });
    }
  }

  return result;
}

/** Convert our tool format to Anthropic format */
function convertTools(tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/** Check if token is an OAuth token (vs API key) */
function isOAuthToken(token: string): boolean {
  return token.startsWith("eyJ") || token.startsWith("sk-ant-oat");
}

/**
 * Stream a response from the Anthropic Messages API.
 * Yields events as they arrive.
 */
export async function* streamAnthropicResponse(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const {
    token,
    model,
    messages,
    systemPrompt,
    tools,
    temperature = 0.7,
    maxTokens = 8192,
  } = options;

  const anthropicMessages = convertMessages(messages);
  const anthropicTools = convertTools(tools);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": token,
    "anthropic-version": API_VERSION,
  };

  // OAuth tokens need extra headers for compatibility
  if (isOAuthToken(token)) {
    headers["Authorization"] = `Bearer ${token}`;
    headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
    headers["user-agent"] = "SecretAgentX/0.2";
    headers["x-app"] = "secret-agent-x";
    delete headers["x-api-key"]; // Use Authorization instead
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: anthropicMessages,
    stream: true,
    temperature,
  };

  if (anthropicTools) {
    body.tools = anthropicTools;
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    yield { type: "error", error: `Anthropic API error (${res.status}): ${errBody.slice(0, 300)}` };
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) { yield { type: "error", error: "No response body" }; return; }

  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let currentToolId = "";
  let currentToolName = "";
  let currentToolArgs = "";

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

      let event: Record<string, unknown>;
      try { event = JSON.parse(data); } catch { continue; }

      const eventType = event.type as string;

      switch (eventType) {
        case "message_start": {
          const usage = (event.message as Record<string, unknown>)?.usage as Record<string, number>;
          if (usage) inputTokens = usage.input_tokens || 0;
          break;
        }

        case "content_block_start": {
          const block = event.content_block as Record<string, unknown>;
          if (block?.type === "tool_use") {
            currentToolId = String(block.id || "");
            currentToolName = String(block.name || "");
            currentToolArgs = "";
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta as Record<string, unknown>;
          if (delta?.type === "text_delta") {
            yield { type: "text", delta: String(delta.text || "") };
          } else if (delta?.type === "input_json_delta") {
            currentToolArgs += String(delta.partial_json || "");
          }
          break;
        }

        case "content_block_stop": {
          if (currentToolId) {
            yield {
              type: "tool_call",
              id: currentToolId,
              name: currentToolName,
              arguments: currentToolArgs,
            };
            currentToolId = "";
            currentToolName = "";
            currentToolArgs = "";
          }
          break;
        }

        case "message_delta": {
          const usage = event.usage as Record<string, number>;
          if (usage) outputTokens = usage.output_tokens || 0;
          break;
        }

        case "message_stop": {
          yield {
            type: "done",
            usage: { inputTokens, outputTokens },
          };
          break;
        }

        case "error": {
          yield { type: "error", error: String((event.error as Record<string, unknown>)?.message || "Unknown error") };
          break;
        }
      }
    }
  }
}
