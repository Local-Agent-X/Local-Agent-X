/**
 * WebSocket-based Codex Responses API client.
 *
 * This is the key to reliable tool chaining. Instead of HTTP request/response
 * per turn, we keep a WebSocket open and feed tool results back immediately.
 * The model keeps working without waiting for the user to say "continue".
 *
 * Protocol: wss://api.openai.com/v1/responses
 * Header: OpenAI-Beta: responses-websocket=v1
 *
 * Flow:
 * 1. Open WebSocket
 * 2. Send response.create with input + tools
 * 3. Receive streaming events (text deltas, tool calls)
 * 4. When tool calls come in, execute them
 * 5. Send tool results back on same WebSocket
 * 6. Model continues automatically — no user nudge needed
 * 7. Repeat until model sends text-only response (no more tool calls)
 */

import WebSocket from "ws";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

const WS_URL = "wss://api.openai.com/v1/responses";

export interface CodexTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CodexWsEvents {
  onText: (delta: string) => void;
  onToolCall: (id: string, name: string, args: string) => void;
  onToolResult: (id: string, name: string, result: string) => void;
  onDone: (usage: { inputTokens: number; outputTokens: number }) => void;
  onError: (error: string) => void;
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

function convertMessagesToInput(messages: ChatCompletionMessageParam[]): unknown[] {
  const input: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content:
          typeof msg.content === "string"
            ? [{ type: "input_text", text: msg.content }]
            : msg.content,
      });
    } else if (msg.role === "assistant") {
      const m = msg as Record<string, unknown>;
      if (m.tool_calls) {
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

/**
 * Run a full agent turn over WebSocket with automatic tool chaining.
 *
 * The model will keep calling tools and receiving results until it
 * produces a text-only response (no tool calls) or hits maxIterations.
 */
export function runCodexWs(params: {
  token: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  systemPrompt: string;
  tools: CodexTool[];
  events: CodexWsEvents;
  executeToolCall: (name: string, args: string) => Promise<string>;
  maxIterations?: number;
}): Promise<void> {
  const {
    token,
    model,
    messages,
    systemPrompt,
    tools,
    events,
    executeToolCall,
    maxIterations = 25,
  } = params;

  const accountId = extractAccountIdFromJwt(token);

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "OpenAI-Beta": "responses-websocket=v1",
      originator: "pi",
      "User-Agent": `sax/${process.platform}`,
    };
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }

    const ws = new WebSocket(WS_URL, { headers });

    let responseId: string | null = null;
    let iteration = 0;
    let currentText = "";
    let pendingToolCalls = new Map<string, { name: string; arguments: string }>();
    let totalUsage = { inputTokens: 0, outputTokens: 0 };

    function sendResponseCreate(input: unknown[], prevResponseId?: string) {
      const payload: Record<string, unknown> = {
        type: "response.create",
        response: {
          model,
          instructions: systemPrompt,
          input,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? "auto" : undefined,
          store: false,
          reasoning: { effort: "low" },
        },
      };

      // Incremental mode: only send new items with previous_response_id
      if (prevResponseId) {
        (payload.response as Record<string, unknown>).previous_response_id = prevResponseId;
      }

      ws.send(JSON.stringify(payload));
    }

    ws.on("open", () => {
      console.log("[codex-ws] Connected");
      // Send initial request
      const input = convertMessagesToInput(messages);
      sendResponseCreate(input);
    });

    ws.on("message", async (data: Buffer) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }

      const type = event.type as string;

      // Text delta
      if (type === "response.output_text.delta" && event.delta) {
        currentText += event.delta as string;
        events.onText(event.delta as string);
      }

      // Function call arguments building
      if (type === "response.function_call_arguments.delta" && event.call_id) {
        const callId = event.call_id as string;
        const existing = pendingToolCalls.get(callId) || {
          name: (event.name as string) || "",
          arguments: "",
        };
        if (event.name) existing.name = event.name as string;
        existing.arguments += (event.delta as string) || "";
        pendingToolCalls.set(callId, existing);
      }

      // Response completed — this is where the magic happens
      if (type === "response.completed" || type === "response.done") {
        const response = event.response as Record<string, unknown> | undefined;

        // Track response ID for incremental mode
        if (response?.id) {
          responseId = response.id as string;
        }

        // Track usage
        const usage = response?.usage as Record<string, number> | undefined;
        if (usage) {
          totalUsage.inputTokens += usage.input_tokens || 0;
          totalUsage.outputTokens += usage.output_tokens || 0;
        }

        // Extract tool calls from completed response
        const output = response?.output as Array<Record<string, unknown>> | undefined;
        const toolCallsInResponse: Array<{ id: string; name: string; arguments: string }> = [];

        if (output) {
          for (const item of output) {
            if (item.type === "function_call" && item.call_id) {
              const tc = {
                id: item.call_id as string,
                name: (item.name as string) || pendingToolCalls.get(item.call_id as string)?.name || "",
                arguments: (item.arguments as string) || pendingToolCalls.get(item.call_id as string)?.arguments || "",
              };
              toolCallsInResponse.push(tc);
            }
          }
        }

        // If there are tool calls, execute them and continue
        if (toolCallsInResponse.length > 0 && iteration < maxIterations) {
          iteration++;
          console.log(`[codex-ws] Iteration ${iteration}: ${toolCallsInResponse.length} tool call(s)`);

          // Execute all tool calls
          const toolResults: unknown[] = [];
          for (const tc of toolCallsInResponse) {
            events.onToolCall(tc.id, tc.name, tc.arguments);

            try {
              const result = await executeToolCall(tc.name, tc.arguments);
              events.onToolResult(tc.id, tc.name, result);
              toolResults.push({
                type: "function_call_output",
                call_id: tc.id,
                output: result,
              });
            } catch (e) {
              const errMsg = `Tool error: ${(e as Error).message}`;
              events.onToolResult(tc.id, tc.name, errMsg);
              toolResults.push({
                type: "function_call_output",
                call_id: tc.id,
                output: errMsg,
              });
            }
          }

          // Send tool results back — model continues automatically!
          pendingToolCalls.clear();
          currentText = "";
          sendResponseCreate(toolResults, responseId || undefined);
        } else {
          // No tool calls — model is done, close connection
          console.log(`[codex-ws] Done after ${iteration} iterations`);
          events.onDone(totalUsage);
          ws.close();
          resolve();
        }
      }
    });

    ws.on("error", (err) => {
      console.error("[codex-ws] Error:", err.message);
      events.onError(err.message);
      reject(err);
    });

    ws.on("close", (code, reason) => {
      if (code !== 1000) {
        console.warn(`[codex-ws] Closed: ${code} ${reason.toString()}`);
      }
      resolve();
    });

    // Global timeout
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        console.warn("[codex-ws] Global timeout (5 min)");
        events.onError("Agent timed out after 5 minutes");
        events.onDone(totalUsage);
        ws.close();
        resolve();
      }
    }, 5 * 60 * 1000);
  });
}
