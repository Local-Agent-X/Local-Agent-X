// Message shape conversion between OpenAI's ChatCompletionMessageParam and
// canonical OpMessageRow. Pure functions — no IO, no logging. Used by
// seedOpMessages (inbound: OpenAI → canonical) and by the chat route at
// turn-end (outbound: canonical → OpenAI, via opMessageRowToChatParam,
// for appending to per-session.messages history).

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { OpMessageRow } from "../types.js";

export function messageRoleToCanonicalRole(role: ChatCompletionMessageParam["role"]): "user" | "assistant" | "tool_result" | null {
  switch (role) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "tool": return "tool_result";
    case "system":
      // Canonical messages don't model "system" as a per-row role — system
      // prompt lives on the adapter. Drop system rows from cleanHistory;
      // their content is already baked into prepared.systemPrompt by
      // prepareAgentRequest.
      return null;
    default: return null;
  }
}

export function extractTextContent(content: ChatCompletionMessageParam["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (!content || !Array.isArray(content)) return "";
  // Multi-part content: concatenate text parts; ignore image parts (handled
  // separately by the adapter when image support lands).
  return content
    .filter((p): p is { type: "text"; text: string } =>
      typeof p === "object" && p !== null && (p as { type?: string }).type === "text" && typeof (p as { text?: string }).text === "string",
    )
    .map(p => p.text)
    .join("\n");
}

/**
 * Inverse of `seedOpMessages` — converts a single canonical `OpMessageRow`
 * back into a `ChatCompletionMessageParam` suitable for `session.messages`.
 *
 * Used by the chat route at turn-end to read the just-finished turn's rows
 * out of `op-messages.jsonl` and append them to the per-session log. This
 * is the path that captures tool_calls and tool_result rows correctly —
 * the old chat.ts synthesis only persisted assistant text, so tool-using
 * turns lost their structured history across turn boundaries.
 *
 * Returns null for rows that should not appear in session.messages
 * (system rows, control rows, or rows with no projectable content).
 */
export function opMessageRowToChatParam(row: OpMessageRow): ChatCompletionMessageParam | null {
  const content = (row.content ?? {}) as {
    text?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    toolCallId?: string;
    kind?: string;
  };
  const text = typeof content.text === "string" ? content.text : "";

  if (row.role === "user") {
    // Drop synthetic nudges (auto-recovery instructions appended by the
    // post-turn detector / dead-end / loop-detection middlewares). They
    // MUST stay as role:"user" in op_messages because the model needs to
    // see them as input on the next turn — but they should never reach
    // session.messages, otherwise the chat-history hydration endpoint
    // (/api/sessions/:id → projectSessionForUI) ships them to the
    // frontend, where the user sees the synthetic instruction rendered
    // as if they typed it. Live failure 2026-05-14: user saw "Your
    // previous attempt produced no visible reply..." and "You called
    // tools but none committed..." as user bubbles in chat.
    if (content.kind === "nudge") return null;
    // Strip the engine-side temporal marker that turn-loop wraps mid-turn
    // injects with — the chat UI / future turns should see what the user
    // actually typed, not the wrapped form.
    const cleaned = text.replace(/^\[mid-turn user message\]\s*/, "");
    if (!cleaned) return null;
    return { role: "user", content: cleaned };
  }
  if (row.role === "assistant") {
    if (Array.isArray(content.toolCalls) && content.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: text,
        tool_calls: content.toolCalls.map(tc => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      } as ChatCompletionMessageParam;
    }
    if (!text) return null;
    return { role: "assistant", content: text };
  }
  if (row.role === "tool_result") {
    // Tool result rows have two shapes:
    //   - just-written by turn-loop: { toolCallId, result, status }
    //   - re-seeded from session.messages: { text, toolCallId }
    // Plus the new image-envelope from chat-tool-dispatcher:
    //   { toolCallId, result: { text, images }, status }
    // All three need to produce a non-empty content field on the chat
    // tool message. Empty content gets dropped by seedOpMessages's
    // filter, orphans the assistant tool_call on the next turn, and
    // triggers Codex 400 "No tool output found for function call X".
    let resultText = text;
    if (!resultText) {
      const r = (content as { result?: unknown }).result;
      if (typeof r === "string") {
        resultText = r;
      } else if (r && typeof r === "object" && typeof (r as { text?: unknown }).text === "string") {
        resultText = (r as { text: string }).text;
      } else if (r != null) {
        resultText = JSON.stringify(r);
      }
    }
    return {
      role: "tool",
      tool_call_id: content.toolCallId ?? "",
      content: resultText,
    } as ChatCompletionMessageParam;
  }
  return null;
}
