/**
 * Waking the chat that started a background op when the op ends, so its agent
 * tells the user how it went, in its own words, at once.
 *
 * Before this the result waited in the pending queue (pending-notifications.ts)
 * for the user's next message, and after two idle minutes the idle nudge
 * posted a canned "that op hit a snag" line: the agent never saw the failure
 * until the user asked (the Home Remote build, 2026-11-16).
 *
 * A chat only runs when it gets a message, so the app sends it one, marked as
 * the app's and not the user's (chat-ws/app-message.ts). Its prompt drains the
 * queue, which hands the agent the op's result and cancels the idle nudge. A
 * turn already running is waited out, and a queue a user turn already drained
 * wakes nothing. Without a chat handler (no server) the idle nudge stays the
 * way the user hears of it.
 */
import { isUserChat, sendAppMessageWhenIdle } from "../chat-ws/app-message.js";
import { hasPendingNotification } from "./pending-notifications.js";
import { scheduleIdleNudge } from "./idle-nudge.js";
import { getOpenTasksForSession } from "../tools/task-tools.js";
import { createLogger } from "../logger.js";

const logger = createLogger("ops.op-report-wake");

/** Ops ending together are reported in one turn. */
export const OP_REPORT_WAKE_DELAY_MS = 1_500;

export type ReportedStatus = "completed" | "partial" | "failed" | "cancelled";

interface Ended { opId: string; task: string; status: ReportedStatus }

const pending = new Map<string, { ops: Ended[]; timer: ReturnType<typeof setTimeout> | null }>();

const STATUS_WORDS: Record<ReportedStatus, string> = {
  completed: "finished",
  partial: "stopped before finishing (its work is saved)",
  failed: "failed",
  cancelled: "was cancelled",
};

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Enough of a step to recognise it; the chat has the full list on screen. */
const STEP_MAX_CHARS = 100;

/**
 * The message the chat receives. The op's result reaches the agent through
 * the queue its prompt drains, so this names the ops and says what to do.
 *
 * The report is not the end of the turn when the work was a step of something
 * the user asked for. Told only "report, and start no new work", a chat that
 * had handed "install it and test it" to a worker reported that the worker
 * stopped early and then stopped too, with the install one command away and
 * its own plan still showing the test step open (Label Check Sol, 2026-11-26).
 * `openSteps` are that plan's open steps: named here because they are the
 * request the ended work belonged to.
 */
export function opReportMessage(ops: Ended[], openSteps: readonly string[] = []): string {
  const owed = openSteps.length === 0 ? [] : [
    "Your plan for the user's request still has these steps open:",
    ...openSteps.map((s, i) => `  ${i + 1}. ${oneLine(s, STEP_MAX_CHARS)}`),
  ];
  return [
    "(Sent by the app, not typed by the user: background work you started has ended.)",
    ...ops.map((o) => `- "${oneLine(o.task, 120)}" ${STATUS_WORDS[o.status]}.`),
    "Tell the user now, in a line or two each: whether it worked, and if not, what went wrong. " +
      "If you already told them in your last reply, say so in one line.",
    ...owed,
    "Then, if what the user asked for is still unfinished and its next step is one you can take yourself, take it now, " +
      "in this same turn, and keep going until it is done or something needs the user. Reporting is not finishing. " +
      "Stop at the report only when the request is complete, or the next step needs the user: then say exactly what you need from them. " +
      "Do not start work the user never asked for.",
  ].join("\n");
}

function flush(sessionId: string): void {
  const entry = pending.get(sessionId);
  if (!entry) return;
  entry.timer = null;
  sendAppMessageWhenIdle(sessionId, () => {
    const current = pending.get(sessionId);
    if (!current) return null;
    pending.delete(sessionId);
    // A user turn since then drained the queue: the agent has it already.
    const ops = current.ops.filter((o) => hasPendingNotification(sessionId, o.opId));
    if (ops.length === 0) return null;
    logger.info(`reporting ${ops.length} ended op(s) to ${sessionId}`);
    return opReportMessage(ops, getOpenTasksForSession(sessionId).map((t) => t.description));
  });
}

function schedule(sessionId: string): void {
  const entry = pending.get(sessionId);
  if (!entry || entry.timer) return;
  entry.timer = setTimeout(() => flush(sessionId), OP_REPORT_WAKE_DELAY_MS);
  entry.timer.unref?.();
}

/** An op `sessionId` started has ended: have its agent report it. */
export function wakeChatForEndedOp(sessionId: string, op: Ended): void {
  if (!isUserChat(sessionId)) return;
  const entry = pending.get(sessionId) ?? { ops: [], timer: null };
  if (!entry.ops.some((o) => o.opId === op.opId)) entry.ops.push(op);
  pending.set(sessionId, entry);
  schedule(sessionId);
}

/** How the chat hears an op it started has ended: the idle nudge is armed as
 *  the fallback, and unless the user heard it already (a voice call spoke it,
 *  or it reports through its own channel) the chat's agent is woken to tell
 *  them, which cancels the nudge. */
export function announceEndedOp(sessionId: string, op: Ended, heardElsewhere: boolean): void {
  scheduleIdleNudge(sessionId, op.task);
  if (!heardElsewhere) wakeChatForEndedOp(sessionId, op);
}

/** Test seams. */
export function _flushOpReportWakeForTest(sessionId: string): void {
  const entry = pending.get(sessionId);
  if (entry?.timer) { clearTimeout(entry.timer); entry.timer = null; }
  flush(sessionId);
}
export function _resetOpReportWakeForTest(): void {
  for (const e of pending.values()) if (e.timer) clearTimeout(e.timer);
  pending.clear();
}
