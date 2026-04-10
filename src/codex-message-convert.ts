/**
 * Codex Responses API message conversion helpers.
 *
 * Handles three concerns that make the Responses API different from
 * Chat Completions:
 *
 * 1. Tool call ID encoding — the API uses TWO identifiers per tool call
 *    (call_id + item.id), but our agent loop stores a single `id` string.
 *    We encode both as "call_id|item_id" for the round-trip.
 *
 * 2. Reasoning replay — the API REQUIRES reasoning items from the previous
 *    turn to be replayed in subsequent requests. We capture them from the
 *    response and store them on assistant messages as `_reasoning`.
 *
 * 3. Input format — Chat Completions messages must be converted to the
 *    Responses API's input item format (input_text, function_call, etc).
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// ── Tool call ID encoding ──

export function encodeToolCallId(callId: string, itemId?: string): string {
  return itemId ? `${callId}|${itemId}` : callId;
}

export function decodeToolCallId(encoded: string): { callId: string; itemId?: string } {
  const [callId, itemId] = encoded.split("|", 2);
  return { callId, ...(itemId ? { itemId } : {}) };
}

// ── Reasoning items ──

export interface ReasoningItem {
  type: "reasoning";
  id?: string;
  encrypted_content?: string;
  summary?: Array<{ type?: string; text?: string }>;
}

export function parseReasoningItem(item: Record<string, unknown>): ReasoningItem | null {
  if (item.type !== "reasoning") return null;
  const result: ReasoningItem = { type: "reasoning" };
  if (typeof item.id === "string" && item.id.startsWith("rs_")) {
    result.id = item.id;
  }
  if (typeof item.encrypted_content === "string") {
    result.encrypted_content = item.encrypted_content;
  }
  if (Array.isArray(item.summary)) {
    result.summary = item.summary as Array<{ type?: string; text?: string }>;
  } else if (typeof item.summary === "string") {
    result.summary = [{ type: "summary_text", text: item.summary }];
  }
  return result;
}

// ── Message conversion ──

export function convertMessagesToInput(
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
      input.push({ type: "message", role: "user", content });
    } else if (msg.role === "assistant") {
      const m = msg as unknown as Record<string, unknown>;

      // Replay reasoning items BEFORE any function calls or text.
      // The Responses API requires reasoning from the previous turn
      // to be present in the input for the next turn.
      if (Array.isArray(m._reasoning)) {
        for (const ri of m._reasoning as ReasoningItem[]) {
          input.push({
            type: "reasoning",
            ...(ri.id ? { id: ri.id } : {}),
            ...(ri.encrypted_content ? { encrypted_content: ri.encrypted_content } : {}),
            ...(ri.summary ? { summary: ri.summary } : {}),
          });
        }
      }

      if (m.tool_calls) {
        // Decode compound tool call IDs (call_id|item_id) back to
        // separate fields for the Responses API.
        for (const tc of m.tool_calls as Array<{
          id: string;
          function: { name: string; arguments: string };
        }>) {
          const { callId, itemId } = decodeToolCallId(tc.id);
          input.push({
            type: "function_call",
            name: tc.function.name,
            call_id: callId,
            ...(itemId ? { id: itemId } : {}),
            arguments: tc.function.arguments,
          });
        }
      }
      if (msg.content) {
        input.push({
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: typeof msg.content === "string" ? msg.content : "" },
          ],
        });
      }
    } else if (msg.role === "tool") {
      // Decode compound IDs — the API expects call_id only.
      const m = msg as { tool_call_id?: string; content?: string };
      const { callId } = decodeToolCallId(m.tool_call_id || "");
      input.push({
        type: "function_call_output",
        call_id: callId || m.tool_call_id,
        output: typeof m.content === "string" ? m.content : "",
      });
    }
  }
  return input;
}
