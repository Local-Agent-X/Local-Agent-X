/**
 * ChatGPT Codex Responses API client.
 * Uses the same endpoint and headers as the pi-ai library.
 * This lets $20/mo ChatGPT subscribers use the API for free.
 *
 * Endpoint: https://chatgpt.com/backend-api/codex/responses
 * Headers: originator, chatgpt-account-id, OpenAI-Beta
 * Format: OpenAI Responses API (not Chat Completions)
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import {
  convertMessagesToInput,
  encodeToolCallId,
  parseReasoningItem,
  type ReasoningItem,
} from "./codex-message-convert.js";

import { createLogger } from "./logger.js";
const logger = createLogger("codex-client");

export type { ReasoningItem } from "./codex-message-convert.js";

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
    id?: string;
    output?: Array<{
      type: string;
      content?: Array<{ type?: string; text?: string }>;
      name?: string;
      call_id?: string;
      arguments?: string;
      // Reasoning items
      summary?: Array<{ type?: string; text?: string }>;
      encrypted_content?: string;
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

export interface CodexResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  reasoning: ReasoningItem[];
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
  sessionId?: string;
  toolChoice?: "auto" | "required";
}): AsyncGenerator<
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "reasoning"; item: ReasoningItem }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number; classification?: import("./response-classifier.js").ClassificationResult }; responseId?: string; reasoning: ReasoningItem[] }
> {
  const accountId = extractAccountIdFromJwt(params.token);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    originator: "pi",
    "User-Agent": `lax (${process.platform} ${process.arch})`,
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
    // Note: Codex subscription endpoint rejects max_output_tokens (400 error).
    // It has an internal cap we can't raise — means prompts must stay lean.
    // "high" causes timeouts on complex prompts. "medium" balances tool reliability
    // with response time. "low" caused ~40% empty responses.
    reasoning: { effort: "medium", summary: "auto" },
  };

  // NOTE: previous_response_id is NOT supported on the Codex subscription
  // endpoint (chatgpt.com/backend-api). Sending it causes 400 Bad Request.
  // Incremental mode will need to work via message-level optimization
  // instead of API-level response chaining.

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = params.toolChoice || "auto";
    body.parallel_tool_calls = true;
  }

  // Codex endpoint does not support temperature

  // Retry logic for transient failures (503, 429, network errors)
  let res: Response;
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 120s connect timeout — once streaming starts, silence detection (90s) takes over.
      res = await fetch(CODEX_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (res.ok) break;

      const errText = await res.text();

      // Retry on transient errors
      if ((res.status === 503 || res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        logger.warn(`[codex] API ${res.status}, retrying in ${waitMs}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      logger.error(`[codex] API error ${res.status}:`, errText.slice(0, 500));
      throw new Error(`Codex API error ${res.status}: ${errText.slice(0, 500)}`);
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      const msg = (e as Error).message;
      // Retry on network/timeout errors
      if (msg.includes("timeout") || msg.includes("fetch") || msg.includes("ECONNRESET")) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        logger.warn(`[codex] Network error, retrying in ${waitMs}ms: ${msg.slice(0, 100)}`);
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
  // Tool calls keyed by item_id (used in streaming events as the lookup key).
  // Each entry stores the compound id (call_id|item_id), name, and arguments.
  const toolCalls = new Map<
    string,
    { id: string; callId: string; itemId: string; name: string; arguments: string }
  >();
  let usage = { inputTokens: 0, outputTokens: 0 };
  let responseId: string | undefined;
  const reasoningItems: ReasoningItem[] = [];

  // Silence-based timeout: abort if no data arrives for 90 seconds
  // Resets every time data flows — so long builds stay alive as long as output is streaming
  const SILENCE_TIMEOUT_MS = 90_000;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  const abortController = new AbortController();

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      logger.warn("[codex] No data for 90s — aborting (silence timeout)");
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

      // Capture tool name + IDs from output_item.added events.
      // This fires BEFORE function_call_arguments deltas and carries:
      //   item.id    = "fc_..." (the output item ID, used as item_id in deltas)
      //   item.call_id = "call_..." (the call ID used for function_call_output)
      if (event.type === "response.output_item.added") {
        const rawItem = event as unknown as Record<string, unknown>;
        const item = rawItem.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const itemId = (item.id as string) || "";
          const callId = (item.call_id as string) || "";
          const lookupKey = itemId || callId;
          if (lookupKey) {
            const existing = toolCalls.get(lookupKey) || {
              id: encodeToolCallId(callId, itemId),
              callId,
              itemId,
              name: "",
              arguments: "",
            };
            if (item.name) existing.name = item.name as string;
            if (callId) existing.callId = callId;
            if (itemId) existing.itemId = itemId;
            existing.id = encodeToolCallId(existing.callId, existing.itemId);
            toolCalls.set(lookupKey, existing);
          }
        }
      }

      // Function call arguments delta — item_id is the lookup key (matches
      // the item.id from output_item.added). Some events use call_id instead.
      if (event.type === "response.function_call_arguments.delta") {
        const rawDelta = event as unknown as Record<string, unknown>;
        const lookupKey = (rawDelta.item_id as string) || event.call_id || "";
        if (lookupKey) {
          const existing = toolCalls.get(lookupKey) || {
            id: lookupKey,
            callId: event.call_id || lookupKey,
            itemId: (rawDelta.item_id as string) || "",
            name: event.name || "",
            arguments: "",
          };
          if (event.name) existing.name = event.name;
          existing.arguments += event.delta || "";
          toolCalls.set(lookupKey, existing);
        }
      }

      // Function call done — yield the complete tool call with compound ID
      if (event.type === "response.function_call_arguments.done") {
        const rawEvent = event as unknown as Record<string, unknown>;
        const lookupKey = (rawEvent.item_id as string) || event.call_id || "";
        const tc = lookupKey ? toolCalls.get(lookupKey) : undefined;
        if (tc && tc.name) {
          yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments };
        } else if (lookupKey) {
          const name = tc?.name || (rawEvent.name as string) || "";
          const args = (rawEvent.arguments as string) || tc?.arguments || "";
          const callId = event.call_id || (rawEvent.call_id as string) || lookupKey;
          const itemId = (rawEvent.item_id as string) || "";
          if (name || args) {
            yield { type: "tool_call", id: encodeToolCallId(callId, itemId), name, arguments: args };
          }
        }
      }

      // Response completed
      if (
        event.type === "response.completed" ||
        event.type === "response.done"
      ) {
        // Capture the response ID for previous_response_id on the next turn
        if (event.response?.id) {
          responseId = event.response.id;
        }

        if (event.response?.usage) {
          usage.inputTokens = event.response.usage.input_tokens || 0;
          usage.outputTokens = event.response.usage.output_tokens || 0;
        }
        // Extract tool calls, text, AND reasoning from the completed response.
        // Some Codex responses arrive as a single completed event without streaming
        // output_text.delta events first — we still need to surface that text.
        if (event.response?.output) {
          for (const item of event.response.output) {
            // Capture reasoning items for replay on the next turn.
            // These contain encrypted_content and summary that must be
            // sent back verbatim — the API rejects requests without them.
            if (item.type === "reasoning") {
              const reasoningItem = parseReasoningItem(item as unknown as Record<string, unknown>);
              if (reasoningItem) {
                reasoningItems.push(reasoningItem);
                yield { type: "reasoning", item: reasoningItem };
              }
              continue;
            }

            if (item.type === "function_call" && item.call_id) {
              // Use the item's own id (fc_...) as lookup key to avoid duplicates
              const lookupKey = (item as unknown as Record<string, unknown>).id as string || item.call_id;
              if (!toolCalls.has(lookupKey)) {
                const itemId = (item as unknown as Record<string, unknown>).id as string || "";
                const compoundId = encodeToolCallId(item.call_id, itemId);
                toolCalls.set(lookupKey, {
                  id: compoundId,
                  callId: item.call_id,
                  itemId,
                  name: item.name || "",
                  arguments: item.arguments || "",
                });
                yield {
                  type: "tool_call",
                  id: compoundId,
                  name: item.name || "",
                  arguments: item.arguments || "",
                };
              }
            }
            // Recover text from message items if we never saw streaming deltas
            if (item.type === "message" && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part.type === "output_text" && typeof part.text === "string" && part.text.length > fullText.length) {
                  const missing = part.text.slice(fullText.length);
                  if (missing) {
                    fullText += missing;
                    yield { type: "text", delta: missing };
                  }
                }
              }
            }
          }
        }

        // Classify the response so upstream knows why it ended the way it did
        const outputSnapshot = event.response?.output ?? null;
        const outputTypesArr = Array.isArray(outputSnapshot) ? outputSnapshot.map((o) => o?.type || "?") : [];
        const { classifyCodexResponse, logClassification } = await import("./response-classifier.js");
        const classification = classifyCodexResponse({
          hasText: !!fullText.trim(),
          hasToolCalls: toolCalls.size > 0,
          outputTypes: outputTypesArr,
          status: (event.response as unknown as Record<string, unknown>)?.status as string | undefined,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        logClassification("codex", params.model, classification);
        // Attach classification to the done event so the agent loop can use it
        (usage as Record<string, unknown>).classification = classification;
      }
    }
  }

  // Clean up silence timer
  if (silenceTimer) clearTimeout(silenceTimer);

  // Fallback: if the stream ended without a response.completed event,
  // yield any tool calls that were collected but never finalized.
  // Codex sometimes closes the stream after delta events but before
  // function_call_arguments.done — we'd lose the tool call otherwise.
  const usageWithMeta = usage as Record<string, unknown>;
  if (!usageWithMeta.classification) {
    logger.warn(`[codex] Stream ended without response.completed event. hasText=${!!fullText.trim()} toolCalls=${toolCalls.size} usage=${usage.inputTokens}in/${usage.outputTokens}out`);

    // Flush collected tool calls that were never yielded (happens on abnormal stream close)
    // Only yield if the arguments are valid JSON — partial args from truncated streams
    // produce broken tool calls with undefined fields.
    for (const tc of toolCalls.values()) {
      if (!tc.name) continue;
      let argsOk = false;
      try { JSON.parse(tc.arguments); argsOk = true; } catch {}
      if (argsOk) {
        logger.warn(`[codex] Flushing unyielded tool call: ${tc.name}(${tc.arguments.slice(0, 100)})`);
        yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments };
      } else {
        logger.error(`[codex] Dropping truncated tool call: ${tc.name}(${tc.arguments.length} bytes of partial JSON). Codex stream closed mid-response — likely hit reasoning budget. Consider reducing prompt complexity or increasing max_tokens.`);
      }
    }

    const { classifyCodexResponse, logClassification } = await import("./response-classifier.js");
    const classification = classifyCodexResponse({
      hasText: !!fullText.trim(),
      hasToolCalls: toolCalls.size > 0,
      outputTypes: [],
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    logClassification("codex", params.model, classification);
    usageWithMeta.classification = classification;
  }

  yield { type: "done", usage, responseId, reasoning: reasoningItems };
}
