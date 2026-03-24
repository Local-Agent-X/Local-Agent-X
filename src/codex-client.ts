/**
 * ChatGPT Codex Responses API client.
 * Uses the same endpoint and headers as upstream's pi-ai library.
 * This lets $20/mo ChatGPT subscribers use the API for free.
 *
 * Endpoint: https://chatgpt.com/backend-api/codex/responses
 * Headers: originator, chatgpt-account-id, OpenAI-Beta
 * Format: OpenAI Responses API (not Chat Completions)
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

interface CodexTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface CodexStreamEvent {
  type: string;
  // response.output_text.delta
  delta?: string;
  // response.function_call_arguments.delta
  name?: string;
  call_id?: string;
  // response.completed / response.done
  response?: {
    output?: Array<{
      type: string;
      content?: Array<{ text?: string }>;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

function extractAccountIdFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    );
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

function convertMessagesToInput(
  messages: ChatCompletionMessageParam[]
): unknown[] {
  const input: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // handled separately as instructions
    if (msg.role === "user") {
      let content: unknown[];
      if (typeof msg.content === "string") {
        content = [{ type: "input_text", text: msg.content }];
      } else if (Array.isArray(msg.content)) {
        // Convert Chat Completions vision format to Responses API format
        content = (msg.content as unknown as Array<Record<string, unknown>>).map((part) => {
          if (part.type === "text") return { type: "input_text", text: part.text };
          if (part.type === "image_url") {
            const iu = part.image_url as { url: string; detail?: string };
            return { type: "input_image", image_url: iu.url, detail: iu.detail || "auto" };
          }
          return part;
        });
      } else {
        content = [{ type: "input_text", text: String(msg.content || "") }];
      }
      input.push({
        type: "message",
        role: "user",
        content,
      });
    } else if (msg.role === "assistant") {
      const m = msg as Record<string, unknown>;
      if (m.tool_calls) {
        // Add function calls as output items
        for (const tc of m.tool_calls as Array<{
          id: string;
          function: { name: string; arguments: string };
        }>) {
          input.push({
            type: "function_call",
            name: tc.function.name,
            call_id: tc.id,
            arguments: tc.function.arguments,
          });
        }
      }
      if (msg.content) {
        input.push({
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: typeof msg.content === "string" ? msg.content : "",
            },
          ],
        });
      }
    } else if (msg.role === "tool") {
      const m = msg as { tool_call_id?: string; content?: string };
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: typeof m.content === "string" ? m.content : "",
      });
    }
  }
  return input;
}

export interface CodexResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  usage: { inputTokens: number; outputTokens: number };
}

export async function* streamCodexResponse(params: {
  token: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  systemPrompt: string;
  tools?: CodexTool[];
  temperature?: number;
  previousResponseId?: string;
  forceToolUse?: boolean;
}): AsyncGenerator<
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number }; responseId?: string }
> {
  const accountId = extractAccountIdFromJwt(params.token);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    originator: "pi",
    "User-Agent": `sax (${process.platform} ${process.arch})`,
  };
  if (accountId) {
    headers["chatgpt-account-id"] = accountId;
  }

  const body: Record<string, unknown> = {
    model: params.model,
    stream: true,
    instructions: params.systemPrompt,
    input: convertMessagesToInput(params.messages),
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    store: false,
    reasoning: { effort: "low" },
  };

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }

  // Codex endpoint does not support temperature

  // Retry logic for transient failures (503, 429, network errors)
  let res: Response;
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // No fetch-level timeout — we handle silence detection in the stream reader instead.
      // This lets long builds run as long as data keeps flowing.
      res = await fetch(CODEX_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (res.ok) break;

      const errText = await res.text();

      // Retry on transient errors
      if ((res.status === 503 || res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.warn(`[codex] API ${res.status}, retrying in ${waitMs}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      console.error(`[codex] API error ${res.status}:`, errText.slice(0, 500));
      throw new Error(`Codex API error ${res.status}: ${errText.slice(0, 500)}`);
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      const msg = (e as Error).message;
      // Retry on network/timeout errors
      if (msg.includes("timeout") || msg.includes("fetch") || msg.includes("ECONNRESET")) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.warn(`[codex] Network error, retrying in ${waitMs}ms: ${msg.slice(0, 100)}`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }

  const reader = res!.body?.getReader();
  if (!reader) throw new Error("Codex returned empty response — try again.");

  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  const toolCalls = new Map<
    string,
    { id: string; name: string; arguments: string }
  >();
  let usage = { inputTokens: 0, outputTokens: 0 };

  // Silence-based timeout: abort if no data arrives for 90 seconds
  // Resets every time data flows — so long builds stay alive as long as output is streaming
  const SILENCE_TIMEOUT_MS = 90_000;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  const abortController = new AbortController();

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      console.warn("[codex] No data for 90s — aborting (silence timeout)");
      abortController.abort();
    }, SILENCE_TIMEOUT_MS);
  }
  resetSilenceTimer();

  while (true) {
    let done: boolean;
    let value: Uint8Array | undefined;
    try {
      const result = await reader.read();
      done = result.done;
      value = result.value;
    } catch {
      break; // Reader aborted by silence timer
    }
    if (done) break;

    resetSilenceTimer(); // Data arrived — reset the silence clock
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      let event: CodexStreamEvent;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      // Text delta
      if (
        event.type === "response.output_text.delta" &&
        event.delta
      ) {
        fullText += event.delta;
        yield { type: "text", delta: event.delta };
      }

      // Function call arguments delta
      if (
        event.type === "response.function_call_arguments.delta" &&
        event.call_id
      ) {
        const existing = toolCalls.get(event.call_id) || {
          id: event.call_id,
          name: event.name || "",
          arguments: "",
        };
        if (event.name) existing.name = event.name;
        existing.arguments += event.delta || "";
        toolCalls.set(event.call_id, existing);
      }

      // Function call done
      if (event.type === "response.function_call_arguments.done" && event.call_id) {
        const tc = toolCalls.get(event.call_id);
        if (tc) {
          yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments };
        }
      }

      // Response completed
      if (
        event.type === "response.completed" ||
        event.type === "response.done"
      ) {
        if (event.response?.usage) {
          usage.inputTokens = event.response.usage.input_tokens || 0;
          usage.outputTokens = event.response.usage.output_tokens || 0;
        }
        // Extract any tool calls from completed response
        if (event.response?.output) {
          for (const item of event.response.output) {
            if (item.type === "function_call" && item.call_id) {
              if (!toolCalls.has(item.call_id)) {
                toolCalls.set(item.call_id, {
                  id: item.call_id,
                  name: item.name || "",
                  arguments: item.arguments || "",
                });
                yield {
                  type: "tool_call",
                  id: item.call_id,
                  name: item.name || "",
                  arguments: item.arguments || "",
                };
              }
            }
          }
        }
      }
    }
  }

  // Clean up silence timer
  if (silenceTimer) clearTimeout(silenceTimer);

  yield { type: "done", usage };
}
