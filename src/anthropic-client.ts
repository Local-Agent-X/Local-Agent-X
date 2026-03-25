/**
 * Anthropic client with dual strategy:
 * 1. Claude CLI proxy (for OAuth — uses `claude -p` which handles all auth natively)
 * 2. Raw HTTP fetch (for direct API keys — sk-ant-api03-*)
 */

import { spawn } from "child_process";
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

const API_BASE = "https://api.anthropic.com";

function isOAuthToken(token: string): boolean {
  return token.includes("sk-ant-oat");
}

// ── Claude CLI proxy (for OAuth tokens) ──

function extractUserPrompt(messages: ChatCompletionMessageParam[]): string {
  // Get the last user message as the prompt
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      return typeof content === "string" ? content : JSON.stringify(content);
    }
  }
  return "";
}

async function* streamViaClaude(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { model, messages, systemPrompt, maxTokens = 16000 } = options;
  const prompt = extractUserPrompt(messages);

  const args = [
    "-p",
    "--model", model,
    "--output-format", "stream-json",
    "--verbose",
  ];

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  try {
    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsVerbatimArguments: false,
    });

    // Send prompt via stdin to avoid shell quoting issues
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    let buffer = "";
    let prevText = "";

    for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
      buffer += chunk.toString();

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === "assistant") {
            // Incremental text from assistant message
            const content = event.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && typeof block.text === "string") {
                  if (block.text.length > prevText.length) {
                    const delta = block.text.slice(prevText.length);
                    prevText = block.text;
                    yield { type: "text", delta };
                  }
                }
              }
            }
          } else if (event.type === "result") {
            // Final result — emit any remaining text
            const result = event.result;
            if (typeof result === "string" && result.length > prevText.length) {
              yield { type: "text", delta: result.slice(prevText.length) };
            }
            yield {
              type: "done",
              usage: {
                inputTokens: event.usage?.input_tokens || 0,
                outputTokens: event.usage?.output_tokens || 0,
              },
            };
            return;
          }
          // Skip system, rate_limit_event, etc.
        } catch {
          // Not valid JSON — skip
        }
      }
    }

    // Process leftover buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === "result") {
          const result = event.result;
          if (typeof result === "string" && result.length > prevText.length) {
            yield { type: "text", delta: result.slice(prevText.length) };
          }
          yield {
            type: "done",
            usage: {
              inputTokens: event.usage?.input_tokens || 0,
              outputTokens: event.usage?.output_tokens || 0,
            },
          };
          return;
        }
      } catch {}
    }

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("close", (code) => resolve(code ?? 0));
    });

    if (exitCode !== 0 && stderr) {
      yield { type: "error", error: `Claude CLI error (${exitCode}): ${stderr.slice(0, 300)}` };
      return;
    }

    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
  } catch (e) {
    yield { type: "error", error: `Claude CLI error: ${(e as Error).message}` };
  }
}

// ── Raw HTTP fetch (for direct API keys) ──

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

function convertMessages(messages: ChatCompletionMessageParam[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      result.push({
        role: "user",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    } else if (msg.role === "assistant") {
      const m = msg as Record<string, unknown>;
      const content: AnthropicContent[] = [];
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
      if (content.length > 0) result.push({ role: "assistant", content });
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

async function* streamViaAPI(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { token, model, messages, systemPrompt, tools, temperature = 1, maxTokens = 8192 } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": token,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "interleaved-thinking-2025-05-14",
  };

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: convertMessages(messages),
    stream: true,
    temperature,
  };

  const anthropicTools = tools?.map(t => ({
    name: t.name, description: t.description, input_schema: t.parameters,
  }));
  if (anthropicTools?.length) body.tools = anthropicTools;

  try {
    const response = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST", headers, body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      yield { type: "error", error: `Anthropic ${response.status}: ${errorText.slice(0, 500)}` };
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
            if (delta?.type === "text_delta") yield { type: "text", delta: delta.text as string };
            else if (delta?.type === "input_json_delta") currentToolArgs += delta.partial_json as string;
          } else if (eventType === "content_block_stop") {
            if (currentToolId) {
              yield { type: "tool_call", id: currentToolId, name: currentToolName, arguments: currentToolArgs };
              currentToolId = ""; currentToolName = ""; currentToolArgs = "";
            }
          } else if (eventType === "message_delta") {
            const usage = parsed.usage as Record<string, number>;
            if (usage) outputTokens = usage.output_tokens || 0;
          }
        }
      }
    }

    yield { type: "done", usage: { inputTokens, outputTokens } };
  } catch (e) {
    yield { type: "error", error: `Anthropic error: ${(e as Error).message?.slice(0, 300)}` };
  }
}

// ── Main entry point ──

/**
 * Stream a response from Anthropic.
 * OAuth tokens (sk-ant-oat*) or "cli" → Claude CLI proxy (handles all auth)
 * API keys (sk-ant-api*) → Direct HTTP to api.anthropic.com
 */
export async function* streamAnthropicResponse(options: StreamOptions): AsyncGenerator<StreamEvent> {
  if (options.token === "cli" || isOAuthToken(options.token)) {
    yield* streamViaClaude(options);
  } else {
    yield* streamViaAPI(options);
  }
}
