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
      // Canonical messages don't model "system" as a per-row role — the
      // system prompt lives on the adapter. These rows are dropped from the
      // seeded op_messages, but their CONTENT must not be lost: the
      // /api/compact summary and truncateHistory's digest both ride
      // `role:"system"` rows in cleanHistory and are NOT part of
      // prepared.systemPrompt (build-system-prompt.ts never sees them). The
      // createChatOp folds them into the system prompt via foldSystemRowsIntoPrompt
      // before the adapter is registered — without that, pressing Compact
      // silently loses ALL prior context on the canonical path.
      return null;
    default: return null;
  }
}

/**
 * Fold every `role:"system"` row's text out of a prepared history and append
 * it beneath the existing system prompt. Pure — returns a new string.
 *
 * On the canonical path history is replayed from op_messages, which has no
 * system role (seedOpMessages drops those rows). The /api/compact summary and
 * truncateHistory's `<prior_conversation>` digest both ride system rows in
 * cleanHistory, and neither is part of prepared.systemPrompt. Without this
 * fold that content never reaches the model, so pressing Compact loses ALL
 * prior context. Rows with no text (or whitespace-only) are skipped so the
 * prompt isn't padded with empty separators.
 */
export function foldSystemRowsIntoPrompt(
  systemPrompt: string,
  history: readonly ChatCompletionMessageParam[],
): string {
  const systemTexts: string[] = [];
  for (const msg of history) {
    if (msg.role !== "system") continue;
    const text = extractTextContent(msg.content).trim();
    if (text) systemTexts.push(text);
  }
  if (systemTexts.length === 0) return systemPrompt;
  return [systemPrompt, ...systemTexts].join("\n\n");
}

type ChatImage = { name: string; url: string };

/** Normalize a stored `content.images` payload down to the {name,url} the
 * session log + frontend need (drops filePath and any malformed entries). */
function normalizeImages(raw: unknown): ChatImage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatImage[] = [];
  for (const im of raw) {
    if (im && typeof im === "object") {
      const url = String((im as { url?: unknown }).url ?? "");
      if (url) out.push({ name: String((im as { name?: unknown }).name ?? ""), url });
    }
  }
  return out;
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
    images?: unknown;
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
    // Carry attachments through to session.messages so photos survive a reload.
    // The seed stores them on the op row (seed-messages.ts); without reading
    // them here a caption-less photo send produced an empty-text row that got
    // dropped below — the whole user turn vanished, image and all.
    const images = normalizeImages(content.images);
    if (!cleaned && images.length === 0) return null;
    const param = { role: "user", content: cleaned } as ChatCompletionMessageParam & { images?: ChatImage[] };
    if (images.length > 0) param.images = images;
    return param;
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
