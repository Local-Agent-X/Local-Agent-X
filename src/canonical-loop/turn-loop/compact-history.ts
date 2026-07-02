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
import { extractText, extractToolResultText } from "./content-extract.js";

// Project canonical rows to the OpenAI-ish shape the context-manager helpers
// read. Lossy by design, but never EMPTY: token counting and the summarizer
// transcript must see tool payloads or a tool-heavy op under-counts and never
// compacts. tool_result payloads live under `content.result` (dispatch-tools.ts)
// and assistant tool calls under `content.toolCalls` (seed-messages.ts) — both
// are surfaced here. tool_result/control collapse to user text so we never need
// a tool_call_id; this projection is never sent to a provider.
export function toChatParams(messages: CanonicalMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case "system": return { role: "system", content: extractText(m.content) };
      case "assistant": return { role: "assistant", content: assistantText(m.content) };
      case "tool_result": return { role: "user", content: `[tool result] ${extractToolResultText(m.content)}` };
      default: return { role: "user", content: extractText(m.content) }; // user + control
    }
  });
}

// Assistant rows carry their tool invocations under `content.toolCalls`; the
// plain text alone blanks a tool-only turn. Append a compact one-line-per-call
// marker so the estimator and summarizer SEE the calls (lossy but non-empty).
function assistantText(content: unknown): string {
  const text = extractText(content);
  const calls =
    content && typeof content === "object"
      ? (content as { toolCalls?: unknown }).toolCalls
      : undefined;
  if (!Array.isArray(calls) || calls.length === 0) return text;
  const markers = calls
    .map((c) => {
      const call = (c ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof call.name === "string" ? call.name : "tool";
      const args = typeof call.arguments === "string" ? call.arguments : "";
      const short = args.length > 200 ? `${args.slice(0, 200)}…` : args;
      return `[called ${name}(${short})]`;
    })
    .join("\n");
  return text ? `${text}\n${markers}` : markers;
}

// Index at which the kept-verbatim tail begins, chosen at a TURN boundary so a
// tool cycle (assistant tool_use → tool_result) is never split — splitting one
// orphans the tool_result and the provider rejects the turn. The tail must never
// START on a `tool_result` (its assistant tool_use would be stranded in the
// summarized head) nor on a mid-cycle `control` row. Both a `user` row and an
// `assistant` row are safe turn-starts: an assistant's tool_results always come
// AFTER it, so splitting on the assistant keeps the pair together. We walk back
// only OFF tool_result/control rows onto the nearest such turn-start — NOT all
// the way to a `user` row, which on a long single-user op is the lone seed at
// index 0, collapsing compaction to a no-op (the very bug this exists to fix).
// Returns 0 when there's nothing safe to compact (caller leaves history intact).
export function safeSplitIndex(messages: CanonicalMessage[], keepLast: number): number {
  if (messages.length <= keepLast + 2) return 0;
  let idx = messages.length - keepLast;
  while (idx > 0 && (messages[idx].role === "tool_result" || messages[idx].role === "control")) idx--;
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

  const anchor = recent[0];
  const block =
    `[Earlier conversation auto-summarized to save context — ${head.length} messages]\n` +
    `${summary}\n` +
    `[End of summary. Your most recent messages follow.]`;

  // Fold the summary into a USER boundary row (no extra message → no adjacent-
  // user rejection, mirrors the situational-awareness digest). But when the tail
  // begins on an ASSISTANT turn-start (the long single-user op, where the head we
  // dropped held the only seed user row), we must NOT overwrite that row: doing
  // so strips its tool_calls and orphans the tool_result that follows. Prepend a
  // standalone user summary row instead — user→assistant is a valid opener and
  // restores the "first message is user" invariant that dropping the seed breaks.
  if (anchor.role === "user") {
    const merged = `${block}\n\n${extractText(anchor.content)}`;
    const mergedAnchor: CanonicalMessage = {
      ...anchor,
      content: hasImages(anchor.content)
        ? { ...(anchor.content as Record<string, unknown>), text: merged }
        : { text: merged },
    };
    return [mergedAnchor, ...recent.slice(1)];
  }
  const summaryRow: CanonicalMessage = {
    messageId: `compact-summary-${anchor.messageId}`,
    role: "user",
    content: { text: block },
  };
  return [summaryRow, ...recent];
}

function hasImages(content: unknown): boolean {
  return (
    !!content &&
    typeof content === "object" &&
    Array.isArray((content as { images?: unknown }).images) &&
    (content as { images: unknown[] }).images.length > 0
  );
}
