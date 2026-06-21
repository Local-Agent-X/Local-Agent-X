// Ephemeral context-window compaction for the canonical loop. The loop replays
// full op_messages every turn; on a long op that eventually overruns the model's
// window. This reshapes the per-turn message view (NEVER op_messages on disk):
// when usage crosses the provider-aware threshold, older turns are replaced by an
// LLM summary and only the recent turns are kept verbatim.
//
// Policy (thresholds, window table, the summarizer) is the canonical
// context-manager subsystem; this module is the CanonicalMessage adapter +
// tool-pairing-safe splitter. A no-op under threshold (the common path), so it
// only pays the summarization cost when actually near the window.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { CanonicalMessage } from "../contract-types.js";
import { getContextStatus } from "../../context-manager/status.js";
import { summarizeOldMessages } from "../../context-manager/compaction.js";

// Project canonical rows to the OpenAI-ish shape the context-manager helpers
// read. Lossy by design — only role + text matter for token counting and the
// summarizer transcript. tool_result/control collapse to user text so we never
// need a tool_call_id; this projection is never sent to a provider.
function toChatParams(messages: CanonicalMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    const text = extractText(m.content);
    switch (m.role) {
      case "system": return { role: "system", content: text };
      case "assistant": return { role: "assistant", content: text };
      case "tool_result": return { role: "user", content: `[tool result] ${text}` };
      default: return { role: "user", content: text }; // user + control
    }
  });
}

// Index at which the kept-verbatim tail begins, chosen at a user-message
// boundary so a tool cycle (assistant tool_use → tool_result) is never split —
// splitting one orphans the tool_result and the provider rejects the turn. A
// user message never sits inside a tool cycle, so the boundary is always safe.
// Returns 0 when there's nothing safe to compact (caller leaves history intact).
export function safeSplitIndex(messages: CanonicalMessage[], keepLast: number): number {
  if (messages.length <= keepLast + 2) return 0;
  let idx = messages.length - keepLast;
  while (idx > 0 && messages[idx].role !== "user") idx--;
  return idx;
}

export async function compactHistory(
  messages: CanonicalMessage[],
  model: string,
): Promise<CanonicalMessage[]> {
  const status = getContextStatus(toChatParams(messages), model);
  if (!status.shouldCompact) return messages;

  let keepLast = 6;
  if (status.percentage >= 95) keepLast = 4;
  if (status.percentage >= 99) keepLast = 2;

  const splitIdx = safeSplitIndex(messages, keepLast);
  if (splitIdx <= 0) return messages;

  const head = messages.slice(0, splitIdx);
  const recent = messages.slice(splitIdx);

  const summary = await summarizeOldMessages(toChatParams(head));
  // Disabled (LAX_LLM_COMPACTION), timed out, or failed: keep the full history
  // rather than silently truncating. An over-window call surfaces as a provider
  // error, which is honest; a silent drop corrupts the conversation.
  if (!summary) return messages;

  // Prepend the summary to the user row at the boundary (mirrors the
  // situational-awareness digest) — no extra message, so no adjacent-user
  // rejection and no leading-system-message handling to worry about.
  const anchor = recent[0];
  const block =
    `[Earlier conversation auto-summarized to save context — ${head.length} messages]\n` +
    `${summary}\n` +
    `[End of summary. Your most recent messages follow.]`;
  const merged = `${block}\n\n${extractText(anchor.content)}`;
  const mergedAnchor: CanonicalMessage = {
    ...anchor,
    content: hasImages(anchor.content)
      ? { ...(anchor.content as Record<string, unknown>), text: merged }
      : { text: merged },
  };
  return [mergedAnchor, ...recent.slice(1)];
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const t = (content as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

function hasImages(content: unknown): boolean {
  return (
    !!content &&
    typeof content === "object" &&
    Array.isArray((content as { images?: unknown }).images) &&
    (content as { images: unknown[] }).images.length > 0
  );
}
