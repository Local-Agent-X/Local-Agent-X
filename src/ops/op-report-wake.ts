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
 * the app's and not the user's, the way the orchestrator is woken
 * (agency/orchestrator-wake.ts). The turn runs through the chat handler a typed
 * message uses; its prompt drains the queue, which hands the agent the op's
 * result and cancels the idle nudge. A turn already running is waited out, and
 * a queue a user turn already drained wakes nothing. Without a chat handler
 * (no server) the idle nudge stays the way the user hears of it.
 */
import { getChatHandler } from "../chat-ws/chat-handler.js";
import { isSyntheticSessionId } from "../memory/synthetic-sessions.js";
import { hasActiveTurn, onTurnRelease } from "../session/turn-lock.js";
import { hasPendingNotification } from "./pending-notifications.js";
import { scheduleIdleNudge } from "./idle-nudge.js";
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

/** The message the chat receives. The op's result reaches the agent through
 *  the queue its prompt drains, so this names the ops and says what to do. */
export function opReportMessage(ops: Ended[]): string {
  return [
    "(Sent by the app, not typed by the user: background work you started has ended.)",
    ...ops.map((o) => `- "${oneLine(o.task, 120)}" ${STATUS_WORDS[o.status]}.`),
    "Tell the user now, in a line or two each: whether it worked, and if not, what went wrong and what you suggest. " +
      "If you already told them in your last reply, say so in one line. Do not start new work they did not ask for.",
  ].join("\n");
}

function flush(sessionId: string): void {
  const entry = pending.get(sessionId);
  if (!entry) return;
  entry.timer = null;
  if (hasActiveTurn(sessionId)) {
    onTurnRelease(sessionId, () => schedule(sessionId));
    return;
  }
  pending.delete(sessionId);
  // A user turn since then drained the queue: the agent has it already.
  const ops = entry.ops.filter((o) => hasPendingNotification(sessionId, o.opId));
  if (ops.length === 0) return;
  const handler = getChatHandler();
  if (!handler) return;
  logger.info(`reporting ${ops.length} ended op(s) to ${sessionId}`);
  void Promise.resolve(handler(sessionId, opReportMessage(ops), [], { channel: "web" }))
    .catch((e) => logger.warn(`op report wake failed for ${sessionId}: ${(e as Error).message}`));
}

function schedule(sessionId: string): void {
  const entry = pending.get(sessionId);
  if (!entry || entry.timer) return;
  entry.timer = setTimeout(() => flush(sessionId), OP_REPORT_WAKE_DELAY_MS);
  entry.timer.unref?.();
}

/** Only a chat with a user behind it is woken: never a background job's
 *  session (dream-, cron-, mail-watch-, ...), a sub-agent's, or a worker op's
 *  own, which hears of its child op through op_wait / op_status. */
function isUserChat(sessionId: string): boolean {
  return !isSyntheticSessionId(sessionId) && !sessionId.startsWith("agent-") && !sessionId.startsWith("op_");
}

/** An op `sessionId` started has ended: have its agent report it. */
export function wakeChatForEndedOp(sessionId: string, op: Ended): void {
  if (!sessionId || !isUserChat(sessionId)) return;
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
