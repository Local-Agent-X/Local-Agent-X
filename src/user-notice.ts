// One-shot user notices: "the app changed something under you — say it ONCE."
//
// The shape of the problem (spend-budget migration, v4 in db-migrations.ts):
// a migration rewrites the user's config at boot, and the owner asked for a
// migrate-AND-tell-them-once rollout. But `up()` cannot tell anyone: migrations
// are awaited in server/index.ts BEFORE the inbox's live frames have anyone to
// reach, and a notice that depended on an open tab was missed by a user who
// never opened the UI between boots, or told again on every restart.
//
// So this is restart-notify.ts's marker/drain shape, aimed at the user inbox
// (src/inbox/): the migration RECORDS a pending notice on disk, and the
// post-bind drain posts it to the inbox once, then records delivery on disk.
// The inbox is durable and shared by every screen (the bell, the phone), so
// delivery never depends on which screen is connected; the ledger's delivered
// marker is what keeps a re-run migration from queueing it twice.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { atomicWriteFileSync } from "./server-utils.js";
import { createLogger } from "./logger.js";
import { inboxUserNotice } from "./inbox/producers.js";

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
 * Post every pending notice to the user inbox, once. A notice the inbox could
 * not record (its file unwritable) stays pending for the next boot. Called
 * once from server/index.ts after the socket is up; when nothing is pending
 * this costs one file read. Returns the ids delivered.
 */
export function drainUserNotices(): string[] {
  const delivered: string[] = [];
  for (const notice of readPendingUserNotices()) {
    if (!inboxUserNotice({ id: notice.id, text: notice.text })) continue;
    markUserNoticeDelivered(notice.id);
    delivered.push(notice.id);
  }
  return delivered;
}
