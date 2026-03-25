/**
 * Anthropic Messages API streaming client using the official SDK.
 * Handles OAuth tokens, beta headers, and proper message format.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

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

/** Check if token is OAuth (vs regular API key) */
function isOAuthToken(token: string): boolean {
  return token.includes("sk-ant-oat");
}

/** Convert OpenAI messages to Anthropic format */
function convertMessages(messages: ChatCompletionMessageParam[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      result.push({
        role: "user",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    } else if (msg.role === "assistant") {
      const m = msg as Record<string, unknown>;
      const content: Anthropic.ContentBlockParam[] = [];

      if (typeof m.content === "string" && m.content) {
        content.push({ type: "text", text: m.content });
      }

      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.function.arguments); } catch {}
          content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
      }

      if (content.length > 0) {
        result.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool") {
      const m = msg as { tool_call_id: string; content: string };
      result.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
      });
    }
  }

  return result;
}

/**
 * Stream a response from Anthropic using the official SDK.
 */
export async function* streamAnthropicResponse(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { token, model, messages, systemPrompt, tools, temperature = 1, maxTokens = 8192 } = options;

  const betaHeaders = isOAuthToken(token)
    ? "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14"
    : "fine-grained-tool-streaming-2025-05-14";

  // OAuth tokens use authToken (Bearer auth), API keys use apiKey (x-api-key header)
  const client = isOAuthToken(token)
    ? new Anthropic({
        apiKey: null as unknown as string,
        authToken: token,
        defaultHeaders: {
          "anthropic-beta": betaHeaders,
          "user-agent": "claude-cli/2.1.75",
          "x-app": "cli",
        },
      })
    : new Anthropic({
        apiKey: token,
        defaultHeaders: { "anthropic-beta": betaHeaders },
      });

  const anthropicMessages = convertMessages(messages);
  const anthropicTools = tools?.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool["input_schema"],
  }));

  try {
    const params: Anthropic.MessageCreateParamsStreaming = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: anthropicMessages,
      stream: true,
      temperature,
    };

    if (anthropicTools && anthropicTools.length > 0) {
      params.tools = anthropicTools;
    }

    const stream = client.messages.stream(params);

    let currentToolId = "";
    let currentToolName = "";
    let currentToolArgs = "";

    stream.on("text", (text) => {
      // Handled in the event loop below
    });

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          currentToolId = block.id;
          currentToolName = block.name;
          currentToolArgs = "";
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text", delta: event.delta.text };
        } else if (event.delta.type === "input_json_delta") {
          currentToolArgs += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        if (currentToolId) {
          yield { type: "tool_call", id: currentToolId, name: currentToolName, arguments: currentToolArgs };
          currentToolId = ""; currentToolName = ""; currentToolArgs = "";
        }
      } else if (event.type === "message_delta") {
        // Usage comes here
      } else if (event.type === "message_stop") {
        // Final
      }
    }

    const finalMessage = await stream.finalMessage();
    yield {
      type: "done",
      usage: {
        inputTokens: finalMessage.usage?.input_tokens || 0,
        outputTokens: finalMessage.usage?.output_tokens || 0,
      },
    };
  } catch (e) {
    yield { type: "error", error: `Anthropic error: ${(e as Error).message?.slice(0, 300)}` };
  }
}
