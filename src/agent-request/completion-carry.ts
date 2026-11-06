/**
 * Background work that stays in the conversation.
 *
 * A worker's result reaches the chat once: the next turn's prompt drains it
 * (ops/pending-notifications.ts, build-system-prompt.ts) and nothing kept it
 * after that turn. On a hosted model the next turns had no trace of it, so a
 * chat whose last word on an email was "it's going out now" told the user it
 * never sent, and offered to send it again (live 2026-11-06: the worker had
 * sent it at 18:04; the 19:40 turn said it hadn't).
 *
 * So the turn that read a completion saves a record of it: a tagged harness row
 * (harness-rows.ts — hidden from the chat UI, memory, retract and fork) after
 * the user's message, replayed on every later turn. It records what finished
 * and how; the one-turn instructions on how to announce it stay in that turn's
 * prompt.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { isHarnessRow, markHarnessRow } from "../harness-rows.js";
import type { PendingNotification } from "../ops/pending-notifications.js";

const ROW_LEAD = "Background work that finished before the user's message above — recorded by the app, not written by the user. "
  + "It already happened: never redo, resend or re-submit it unless the user asks.";
const TASK_CHARS = 200;
const SUMMARY_CHARS = 400;

const OUTCOME: Record<PendingNotification["status"], string> = {
  completed: "Completed",
  partial: "Stopped unfinished",
  failed: "Failed",
  cancelled: "Cancelled",
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function recordLine(n: PendingNotification): string {
  if (n.verification) {
    return `- Re-check of the deliverable for "${clip(n.task, TASK_CHARS)}": ${n.verification.mismatched} of ${n.verification.checked} values `
      + (n.verification.corrected ? "were corrected." : "did not match and were left to correct.");
  }
  const what = n.subAgent ? `Sub-agent ${n.task}` : `"${clip(n.task, TASK_CHARS)}" (op ${n.opId})`;
  return `- ${OUTCOME[n.status]}: ${what}. ${clip(n.summary.trim(), SUMMARY_CHARS)}`;
}

/** The row recording what finished, or null when nothing did. */
export function completionRow(completions: readonly PendingNotification[]): ChatCompletionMessageParam | null {
  if (completions.length === 0) return null;
  return markHarnessRow({ role: "user", content: `${ROW_LEAD}\n${completions.map(recordLine).join("\n")}` }, "completion");
}

/**
 * A turn's new rows with the record of what finished placed after the user's
 * message and any harness rows that follow it, inside the turn so
 * retract-last-turn takes it with the turn. Every path that saves a turn goes
 * through this: chat (routes/chat/run-chat-turn/canonical-run.ts) and voice
 * (server/voice-ws.ts).
 */
export function withCompletionsCarried(
  turnRows: ChatCompletionMessageParam[],
  completions: readonly PendingNotification[] | undefined,
): ChatCompletionMessageParam[] {
  const row = completionRow(completions ?? []);
  if (!row) return turnRows;
  let at = turnRows.findIndex((m) => m.role === "user" && !isHarnessRow(m));
  if (at < 0) return turnRows;
  while (at + 1 < turnRows.length && isHarnessRow(turnRows[at + 1])) at++;
  return [...turnRows.slice(0, at + 1), row, ...turnRows.slice(at + 1)];
}
