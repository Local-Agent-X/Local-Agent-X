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

/** Convert OpenAI-style user content (text OR array of text+image_url parts) to Anthropic format. */
export function convertUserContent(content: unknown): string | AnthropicContent[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const out: AnthropicContent[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part.type === "text") {
      out.push({ type: "text", text: String(part.text || "") });
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
  return out.length > 0 ? out : "";
}

export function convertMessages(messages: ChatCompletionMessageParam[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  const seenToolUseIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      result.push({ role: "user", content: convertUserContent(msg.content) });
    } else if (msg.role === "assistant") {
      const m = msg as unknown as Record<string, unknown>;
      const content: AnthropicContent[] = [];
      if (typeof m.content === "string" && m.content) {
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
          content.push({ type: "tool_use", id: toolId, name: tc.function.name, input });
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
