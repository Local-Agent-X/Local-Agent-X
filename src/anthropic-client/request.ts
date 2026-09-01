import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AnthropicContent, AnthropicMessage } from "./types.js";

export const API_BASE = "https://api.anthropic.com";

// Global counter — guarantees unique tool_use IDs across all CLI proxy calls
let _toolCallSeq = 0;
export function newToolCallId(name: string): string {
  return `tc_${Date.now()}_${++_toolCallSeq}_${name}`;
}

export function extractUserPrompt(messages: ChatCompletionMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        let imageCount = 0;
        for (const part of content as unknown as Array<Record<string, unknown>>) {
          if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
            textParts.push(part.text);
          } else if (part.type === "image_url") {
            imageCount++;
          }
        }
        const prefix = imageCount > 0 ? `[User attached ${imageCount} image${imageCount === 1 ? "" : "s"}]\n\n` : "";
        return prefix + textParts.join("\n\n");
      }
      return String(content ?? "");
    }
  }
  return "";
}

/** Stand-in for a user turn that carried no text and no images. The Messages
 *  API rejects both an empty content array and an empty text block
 *  ("text content blocks must be non-empty"), so the wire invariant is: every
 *  text block we emit has non-whitespace text, and every user row has at
 *  least one block. */
const EMPTY_USER_PLACEHOLDER = "[empty message]";

/** Convert OpenAI-style user content (text OR array of text+image_url parts) to Anthropic format.
 *  Never returns empty/whitespace-only content — see EMPTY_USER_PLACEHOLDER. */
export function convertUserContent(content: unknown): string | AnthropicContent[] {
  if (!Array.isArray(content)) {
    const text = typeof content === "string" ? content : String(content ?? "");
    return text.trim() ? text : [{ type: "text", text: EMPTY_USER_PLACEHOLDER }];
  }
  const out: AnthropicContent[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part.type === "text") {
      // Empty/whitespace text parts are dropped rather than forwarded — the
      // API 400s on them. Mirrors extractUserPrompt's filter on the CLI leg.
      const text = String(part.text || "");
      if (text.trim()) out.push({ type: "text", text });
    } else if (part.type === "image_url") {
      const iu = part.image_url as { url: string } | undefined;
      const url = iu?.url || "";
      // data:image/png;base64,XXXX → extract media_type + data
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      } else if (url) {
        out.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  // Image-only content is valid as-is; only a fully empty row needs the stand-in.
  return out.length > 0 ? out : [{ type: "text", text: EMPTY_USER_PLACEHOLDER }];
}

export function convertMessages(messages: ChatCompletionMessageParam[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  const seenToolUseIds = new Set<string>();
  // Original tool_call id → FIFO queue of emitted tool_use ids. When a duplicate
  // id is renamed on the assistant side, the matching tool_result (which still
  // carries the original id) must be renamed to the same value, in order.
  const pendingResultIds = new Map<string, string[]>();

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      result.push({ role: "user", content: convertUserContent(msg.content) });
    } else if (msg.role === "assistant") {
      const m = msg as unknown as Record<string, unknown>;
      const content: AnthropicContent[] = [];
      // trim(): a whitespace-only assistant text (common on tool-call-only
      // turns) must not become an empty text block alongside the tool_use.
      if (typeof m.content === "string" && m.content.trim()) {
        content.push({ type: "text", text: m.content });
      }
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.function.arguments); } catch {}
          // Deduplicate tool_use IDs — Anthropic rejects duplicates across the message array
          let toolId = tc.id;
          if (seenToolUseIds.has(toolId)) {
            toolId = `${toolId}_${++_toolCallSeq}`;
          }
          seenToolUseIds.add(toolId);
          const queue = pendingResultIds.get(tc.id);
          if (queue) queue.push(toolId);
          else pendingResultIds.set(tc.id, [toolId]);
          content.push({ type: "tool_use", id: toolId, name: tc.function.name, input });
        }
      }
      if (content.length > 0) result.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      const m = msg as { tool_call_id: string; content: string };
      const queue = pendingResultIds.get(m.tool_call_id);
      const toolUseId = queue && queue.length > 0 ? (queue.shift() as string) : m.tool_call_id;
      result.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: m.content }],
      });
    }
  }
  return result;
}
