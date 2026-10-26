/**
 * Raw tool output from finished turns is dropped from the model's view of the
 * conversation before anything else is done to it.
 *
 * Measured on the owner's chat ops (2026-10-25, seven heavy turns): tool
 * results were 83% of what a turn added to context (59–98%), and one coding
 * turn added 94K tokens that way. Summarizing the whole conversation every two
 * or three turns to make room for the next file dump is what made each summary
 * a summary of a summary. The dialogue is not the bulk; the dumps are. So a
 * tool result from a turn before the most recent one is replaced with a
 * one-line stub naming the tool and the size of what it returned — the file is
 * still on disk and the command can be re-run — while every user and assistant
 * row stays verbatim and the newest finished turn is kept whole, since "now
 * edit what you just read" refers to it.
 *
 * The view is a pure function of the history: every tool row before the last
 * user-authored row is stubbed, the same way every request. The bytes before
 * that boundary are therefore identical from one message to the next, which is
 * what a provider's prefix cache needs (cache-prefix rule, checkpoint-history.ts);
 * only the just-finished turn's rows change, once, at the start of the next.
 * The transcript itself is untouched: the chat, fork, export and recall still
 * show everything. Row count is preserved so a checkpoint's coversThrough
 * index still means the same rows.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { isHarnessRow } from "../harness-rows.js";
import { elidedToolResultStub } from "../harness-text.js";
import { PRUNED_RESULT_KEEP_CHARS } from "./compaction-policy.js";

type Row = ChatCompletionMessageParam & { tool_call_id?: string; tool_calls?: Array<{ id: string; function?: { name?: string } }> };

/** Index of the row that starts the most recent finished turn: the last
 *  user-authored row. Harness rows (nudges, recall) are not turns. */
export function lastTurnStart(messages: readonly ChatCompletionMessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !isHarnessRow(messages[i])) return i;
  }
  return -1;
}

/** The history with tool results from turns before the last one stubbed. */
export function pruneFinishedTurnToolResults(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const boundary = lastTurnStart(messages);
  if (boundary <= 0) return messages;
  const names = new Map<string, string>();
  for (let i = 0; i < boundary; i++) {
    const calls = (messages[i] as Row).tool_calls;
    if (messages[i].role === "assistant" && Array.isArray(calls)) {
      for (const c of calls) names.set(c.id, c.function?.name ?? "tool");
    }
  }
  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= boundary || m.role !== "tool" || typeof m.content !== "string") return m;
    if (m.content.length <= PRUNED_RESULT_KEEP_CHARS) return m;
    changed = true;
    const name = names.get((m as Row).tool_call_id ?? "") ?? "tool";
    return { ...m, content: elidedToolResultStub(name, m.content.length) } as ChatCompletionMessageParam;
  });
  return changed ? out : messages;
}
