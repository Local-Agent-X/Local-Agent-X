/**
 * Idle nudge — proactive "by the way, the op finished" message when the
 * user goes idle after a worker completes.
 *
 * Without this, the auto-narrate pattern requires the user to send another
 * message before they hear that the work is done. Voice users (eyes off
 * screen) and text users who context-switched both lose the signal. The
 * nudge fires after a short delay if the pending-notifications queue still
 * has unsurfaced completions.
 *
 * Lifecycle per session:
 *   - Worker completes → session-bridge calls schedule()
 *   - User sends a message before timer fires → cancel() (queue gets drained
 *     naturally on the next turn, no nudge needed)
 *   - Timer fires with queue still populated → push a `bg_op_nudge` chat
 *     event AND drain the queue (so the agent doesn't double-narrate on
 *     the user's eventual next turn)
 *   - Timer fires with queue already empty → no-op
 */
import type { ServerEvent } from "../types.js";
import { drainPendingNotifications, type PendingNotification } from "./pending-notifications.js";
import { createLogger } from "../logger.js";
const logger = createLogger("workers.idle-nudge");

const IDLE_NUDGE_MS = 2 * 60 * 1000;
const EXPLICIT_NOTIFY_MS = 1000;

// User intent: "tell me / let me know / notify me / ping me when this is
// done." When detected we fire near-immediately on completion instead of
// waiting the full idle window — the user explicitly asked to be told.
const EXPLICIT_NOTIFY_RE = /\b(tell|let|notify|ping|alert|message|update)\s+(me|us)\s+(when|once|after|as\s+soon\s+as|the\s+moment|right\s+when)\b/i;

const timers = new Map<string, NodeJS.Timeout>();

// Sessions whose most recent USER MESSAGE contained explicit-notify intent
// ("tell me when done", "let me know once it's ready", etc.). Set by
// prepare-request when a new chat message arrives; checked by
// scheduleIdleNudge so an agent-rephrased task that drops the trigger
// phrase still fires fast. Cleared on next user message (because that
// message either already drained the queue or is a fresh intent context).
const explicitNotifyFlags = new Set<string>();

export function markSessionExplicitNotify(sessionId: string, userMessage: string): void {
  if (!sessionId || !userMessage) return;
  if (EXPLICIT_NOTIFY_RE.test(userMessage)) {
    explicitNotifyFlags.add(sessionId);
  }
}

// Last user message per session — used by op_submit_async to detect "casual
// reply" patterns ("yo", "hey", "ok") that shouldn't trigger new worker spawns.
const lastUserMessages = new Map<string, string>();
const SHORT_CASUAL_RE = /^(yes|no|ok|okay|sure|thanks|thx|ty|hi|hello|hey|yo|sup|cool|nice|great|thanks!|got it|kk|k|alright)\b/i;

export function recordSessionLastMessage(sessionId: string, userMessage: string): void {
  if (!sessionId || !userMessage) return;
  lastUserMessages.set(sessionId, userMessage);
}

export function isLastMessageCasual(sessionId: string): boolean {
  const msg = lastUserMessages.get(sessionId);
  if (!msg) return false;
  const trimmed = msg.trim();
  return trimmed.length <= 30 || SHORT_CASUAL_RE.test(trimmed);
}

let broadcaster: ((sessionId: string, event: ServerEvent) => void) | null = null;
let persister: ((sessionId: string, content: string) => void) | null = null;

export function setIdleNudgeBroadcaster(fn: (sessionId: string, event: ServerEvent) => void): void {
  broadcaster = fn;
}

export function setIdleNudgePersister(fn: (sessionId: string, content: string) => void): void {
  persister = fn;
}

export function scheduleIdleNudge(sessionId: string, taskHint?: string): void {
  if (!sessionId) return;
  // Cancel any prior timer but DO NOT clear the explicit-notify flag — that
  // flag tracks the user's most recent intent ("tell me when done") and a
  // newly-completing op should still honor it. Only a new user message
  // clears the flag (via cancelIdleNudge from prepare-request.ts).
  const priorHandle = timers.get(sessionId);
  if (priorHandle) {
    clearTimeout(priorHandle);
    timers.delete(sessionId);
  }
  const explicitFromUserMsg = explicitNotifyFlags.has(sessionId);
  const explicitFromTask = !!(taskHint && EXPLICIT_NOTIFY_RE.test(taskHint));
  const explicit = explicitFromUserMsg || explicitFromTask;
  const delay = explicit ? EXPLICIT_NOTIFY_MS : IDLE_NUDGE_MS;
  const reason = explicitFromUserMsg ? "explicit-notify (user msg)"
    : explicitFromTask ? "explicit-notify (task)"
    : "idle";
  logger.info(`scheduled session=${sessionId} delay=${delay}ms (${reason})`);
  const handle = setTimeout(() => {
    timers.delete(sessionId);
    fireNudge(sessionId);
  }, delay);
  timers.set(sessionId, handle);
}

export function cancelIdleNudge(sessionId: string): void {
  const handle = timers.get(sessionId);
  if (handle) {
    clearTimeout(handle);
    timers.delete(sessionId);
  }
  explicitNotifyFlags.delete(sessionId);
}

function fireNudge(sessionId: string): void {
  if (!broadcaster) {
    logger.warn(`fired session=${sessionId} but no broadcaster registered — nudge dropped`);
    return;
  }
  const items = drainPendingNotifications(sessionId);
  if (items.length === 0) {
    logger.info(`fired session=${sessionId} but queue empty — user must have replied first`);
    return;
  }

  const text = composeNudgeText(items);
  try {
    broadcaster(sessionId, { type: "bg_op_nudge", opIds: items.map(i => i.opId), text });
    logger.info(`pushed session=${sessionId} ops=${items.length} text="${text.slice(0, 80)}..."`);
  } catch (e) {
    logger.warn(`broadcast threw for session=${sessionId}: ${(e as Error).message}`);
  }

  if (persister) {
    try { persister(sessionId, text); } catch { /* persistence is best-effort */ }
  }
}

function composeNudgeText(items: PendingNotification[]): string {
  if (items.length === 1) {
    const n = items[0];
    const taskPreview = n.task.slice(0, 80).trim() + (n.task.length > 80 ? "…" : "");
    if (n.status === "completed") {
      return `Quick heads up — that op just finished (${taskPreview}). Want me to walk through what landed?`;
    }
    if (n.status === "failed") {
      return `Heads up — that op hit a snag (${taskPreview}). Want me to look at what went wrong?`;
    }
    return `Heads up — that op was cancelled (${taskPreview}).`;
  }
  const completed = items.filter(i => i.status === "completed").length;
  const failed = items.filter(i => i.status === "failed").length;
  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} finished`);
  if (failed > 0) parts.push(`${failed} failed`);
  return `Heads up — ${items.length} background op${items.length === 1 ? "" : "s"} wrapped while you were away (${parts.join(", ")}). Want a rundown?`;
}
