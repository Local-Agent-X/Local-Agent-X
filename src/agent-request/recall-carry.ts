/**
 * Recall that stays in the conversation.
 *
 * Associative recall is rebuilt from each new message. A message with no topic
 * words recalls nothing, so the evidence an answer stood on was gone from the
 * very next turn: "you made that up" has no topic words. Measured 2026-10-08/09
 * (qwen3.6:27b eval): relevant-memories held the user's own message on the
 * question turn and was absent on the pushback turn in every run, and the model
 * retracted a true fact each time — the same shape as the live 2026-10-05
 * flip-flop, where the section shrank from ~2.1 kB to 1.1 kB on the turn the
 * agent called the fact invented.
 *
 * So what recall surfaced for a turn is kept: saved as a tagged harness row
 * (harness-rows.ts — hidden from the chat UI, memory indexing, the delete gate,
 * retract and fork) right after the user's message it answered, and replayed on
 * later turns like any other row. The prompt renders only entries the chat does
 * not already carry, and the row saves only those, so nothing repeats.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { harnessRowKind, isHarnessRow, markHarnessRow } from "../harness-rows.js";
import { renderRecalledMemory, type RecalledMemory } from "../memory/auto-search-context.js";
import { asRecalledData } from "../context/system-prompt-builder.js";

const REF = /\bref: ([A-Za-z0-9]+)/g;

// Where the entries come from is said here too: replies placed a message from
// an earlier chat "in this same chat" when only the row sat in this one
// (qwen3.6:27b, 2026-10-13).
const ROW_LEAD = "Recalled memory for the user's message above — retrieved by the app at the time, not written by the user. "
  + "Entries marked PAST SESSION come from earlier, separate chats; each says its own session and date.";

/** Entry refs the chat's saved recall rows already carry. */
export function carriedRecallRefs(history: readonly ChatCompletionMessageParam[]): Set<string> {
  const refs = new Set<string>();
  for (const m of history) {
    if (harnessRowKind(m) !== "recall" || typeof m.content !== "string") continue;
    for (const hit of m.content.matchAll(REF)) refs.add(hit[1]);
  }
  return refs;
}

/** This turn's recall minus what the chat already carries; null when nothing is new. */
export function uncarriedRecall(
  recall: RecalledMemory | null,
  history: readonly ChatCompletionMessageParam[],
): RecalledMemory | null {
  if (!recall) return null;
  const carried = carriedRecallRefs(history);
  const entries = recall.entries.filter((e) => !carried.has(e.ref));
  return entries.length > 0 ? { ...recall, entries } : null;
}

/** The row that carries a turn's recall forward. */
export function recallRow(recall: RecalledMemory | null): ChatCompletionMessageParam | null {
  const body = renderRecalledMemory(recall);
  if (!body) return null;
  return markHarnessRow({ role: "user", content: `${ROW_LEAD}${asRecalledData("relevant-memories", body)}` }, "recall");
}

/**
 * A turn's new rows with its recall placed right after the user's message —
 * inside the turn, so retract-last-turn (which cuts from the last user-authored
 * row) takes it with the turn. Every path that saves a turn goes through this:
 * chat (routes/chat/run-chat-turn/canonical-run.ts) and voice (server/voice-ws.ts).
 */
export function withRecallCarried(
  turnRows: ChatCompletionMessageParam[],
  recall: RecalledMemory | null,
): ChatCompletionMessageParam[] {
  const row = recallRow(recall);
  if (!row) return turnRows;
  const at = turnRows.findIndex((m) => m.role === "user" && !isHarnessRow(m));
  return at < 0 ? turnRows : [...turnRows.slice(0, at + 1), row, ...turnRows.slice(at + 1)];
}
