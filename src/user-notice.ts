// One-shot user notices: "the app changed something under you — say it ONCE."
//
// The shape of the problem (spend-budget migration, v4 in db-migrations.ts):
// a migration rewrites the user's config at boot, and the owner asked for a
// migrate-AND-tell-them-once rollout. But `up()` cannot tell anyone: migrations
// are awaited in server/index.ts BEFORE createHttpServer binds, so at migration
// time there is no socket and no client. And an in-memory "already told them"
// flag is wrong too — a user who never opens the UI between boots would either
// miss the notice entirely or be told again on every restart.
//
// So this is restart-notify.ts's marker/drain shape, aimed at the UI instead of
// the messaging bridges: the migration RECORDS a pending notice on disk, and a
// post-bind drain BROADCASTS it once a real client is connected, then records
// delivery on disk. Durability is the file, not a flag, so exactly-once holds
// across restarts.
//
// Delivery is a plain top-level chat-ws broadcast (`{type:"user_notice"}`),
// deliberately NOT a ServerEvent — same class as `system_health`. A ServerEvent
// is session-scoped and must cross the process relay's allowlists; this notice
// belongs to no session and is emitted by the server process that owns the
// WebSocket, so it never touches the relay.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { atomicWriteFileSync } from "./server-utils.js";
import { createLogger } from "./logger.js";

const logger = createLogger("user-notice");

export interface PendingUserNotice {
  id: string;
  text: string;
  recordedAt: number;
}

interface UserNoticeLedger {
  pending: PendingUserNotice[];
  /** The durable delivered-marker. Presence here is what makes a notice
   *  never come back — both for the drain (nothing left pending) and for
   *  recordUserNotice (a re-run can't re-queue what was already shown). */
  delivered: Array<{ id: string; deliveredAt: number }>;
}

/** Broadcast fn shape: chat-ws `broadcastAll`, returning the number of OPEN
 *  clients that actually received the payload. 0 means "nobody was
 *  listening" — the notice must stay pending. */
export type NoticeBroadcast = (data: Record<string, unknown>) => number;

export const SPEND_BUDGET_NOTICE_ID = "spend-budget-defaults";
export const SPEND_BUDGET_NOTICE_TEXT =
  "Spend caps are now on by default: $75/day and $15/session. On a subscription login the cost is shown but is never a real charge and never stops anything. Set either to 0 in Settings for no cap.";

function ledgerPath(): string {
  return join(getLaxDir(), "user-notices.json");
}

function emptyLedger(): UserNoticeLedger {
  return { pending: [], delivered: [] };
}

function readLedger(): UserNoticeLedger {
  try {
    const p = ledgerPath();
    if (!existsSync(p)) return emptyLedger();
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<UserNoticeLedger>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyLedger();
    return {
      pending: Array.isArray(raw.pending)
        ? raw.pending.filter((n) => n && typeof n.id === "string" && typeof n.text === "string")
        : [],
      delivered: Array.isArray(raw.delivered)
        ? raw.delivered.filter((d) => d && typeof d.id === "string")
        : [],
    };
  } catch {
    return emptyLedger();
  }
}

function writeLedger(ledger: UserNoticeLedger): void {
  try {
    atomicWriteFileSync(ledgerPath(), JSON.stringify(ledger, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (e) {
    logger.warn(`[user-notice] could not write ledger: ${(e as Error).message}`);
  }
}

/**
 * Queue a notice for the next post-bind drain. Idempotent by id: a notice
 * already pending, or already delivered, is never queued twice — so this is
 * safe to call from a migration that might be re-run against a data dir whose
 * ledger survived.
 */
export function recordUserNotice(id: string, text: string): void {
  const ledger = readLedger();
  if (ledger.delivered.some((d) => d.id === id)) return;
  if (ledger.pending.some((n) => n.id === id)) return;
  ledger.pending.push({ id, text, recordedAt: Date.now() });
  writeLedger(ledger);
}

export function readPendingUserNotices(): PendingUserNotice[] {
  return readLedger().pending;
}

export function hasDeliveredUserNotice(id: string): boolean {
  return readLedger().delivered.some((d) => d.id === id);
}

/** Record delivery durably: drop it from pending AND stamp it delivered. */
export function markUserNoticeDelivered(id: string): void {
  const ledger = readLedger();
  const before = ledger.pending.length;
  ledger.pending = ledger.pending.filter((n) => n.id !== id);
  if (before === ledger.pending.length && ledger.delivered.some((d) => d.id === id)) return;
  if (!ledger.delivered.some((d) => d.id === id)) {
    ledger.delivered.push({ id, deliveredAt: Date.now() });
  }
  writeLedger(ledger);
}

/**
 * Try once to deliver every pending notice. A notice is only marked delivered
 * when at least one OPEN client received it — a broadcast into an empty room
 * leaves it pending for the next attempt (or the next boot), which is what
 * makes "a user who never opened the UI still gets it" true.
 *
 * Returns the ids actually delivered.
 */
export function drainUserNotices(broadcast: NoticeBroadcast): string[] {
  const pending = readPendingUserNotices();
  if (pending.length === 0) return [];
  const delivered: string[] = [];
  for (const notice of pending) {
    let sent = 0;
    try {
      sent = broadcast({ type: "user_notice", noticeId: notice.id, text: notice.text });
    } catch (e) {
      logger.warn(`[user-notice] broadcast of "${notice.id}" failed: ${(e as Error).message}`);
      continue;
    }
    if (sent > 0) {
      markUserNoticeDelivered(notice.id);
      delivered.push(notice.id);
    }
  }
  return delivered;
}

export interface NoticeDrainOptions {
  /** How often to retry while nobody is connected yet. */
  intervalMs?: number;
  /** Stop retrying after this long; the notice stays pending for next boot. */
  maxWaitMs?: number;
}

/**
 * Post-bind drain. Called once from server/index.ts right after the HTTP/WS
 * server is created. If nothing is pending this costs one file read and starts
 * no timer at all — the common case for every boot after the first.
 *
 * Returns a stop() for tests and for a caller that wants to cancel the wait.
 */
export function startUserNoticeDrain(
  broadcast: NoticeBroadcast,
  opts: NoticeDrainOptions = {},
): () => void {
  if (readPendingUserNotices().length === 0) return () => {};
  const intervalMs = opts.intervalMs ?? 2_000;
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  const startedAt = Date.now();

  drainUserNotices(broadcast);
  if (readPendingUserNotices().length === 0) return () => {};

  const timer = setInterval(() => {
    drainUserNotices(broadcast);
    if (readPendingUserNotices().length === 0 || Date.now() - startedAt > maxWaitMs) {
      clearInterval(timer);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
