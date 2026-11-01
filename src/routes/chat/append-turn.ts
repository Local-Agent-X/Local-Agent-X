import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { stripEphemeralMessages } from "../../providers/sanitize.js";
import { COMPACTION_PREFIX } from "../../types.js";

/**
 * Add one turn's rows to the stored conversation. A turn only ever ADDS: the
 * transcript file is rewritten from `session.messages` on every save
 * (memory/session-message-log.ts writeSessionLog), so a writer that set it to
 * the run's own view of the history (the compaction checkpoint plus the recent
 * tail) erased every older message from disk. The delegation ack turn did
 * that (2026-11-01); the chat turn appended. Both go through here now.
 *
 * Kept: the user's /api/compact summary row (the only system row that belongs
 * to the conversation), tool rows, and any row with text, tool calls or images.
 */
export function appendTurnToSession(
  session: { messages: ChatCompletionMessageParam[] },
  turnRows: ChatCompletionMessageParam[],
): void {
  session.messages = stripEphemeralMessages([...session.messages, ...turnRows]).filter((m) => {
    if (m.role === "system") return typeof m.content === "string" && m.content.startsWith(COMPACTION_PREFIX);
    if (m.role === "tool") return true;
    return Boolean(m.content || (m as { tool_calls?: unknown }).tool_calls || (m as { images?: unknown[] }).images?.length);
  });
}
