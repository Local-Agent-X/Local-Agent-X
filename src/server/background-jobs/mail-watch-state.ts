// What the mail watcher remembers between passes, at
// <lax data dir>/mail-watch.json: where it stopped reading each account, which
// senders the user has written to, the messages waiting for the morning
// digest, and today's model-call count. Losing the file costs one re-read of
// the last day's mail, nothing more.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { atomicWriteFileSync } from "../../util/json-store.js";

/** Where reading stopped in one account's inbox. A uid means nothing outside
 *  its UIDVALIDITY, so the two are kept together. */
export interface MailCheckpoint {
  uidValidity: string;
  lastUid: number;
}

export interface DigestEntry {
  from: string;
  subject: string;
  /** ISO date the message arrived. */
  date: string;
}

export interface MailWatchState {
  accounts: Record<string, MailCheckpoint>;
  /** Sender address → whether the user has sent mail to it, and when that
   *  was last checked (epoch ms). */
  known: Record<string, { known: boolean; checkedAt: number }>;
  digest: { pending: DigestEntry[]; skipped: number; lastPostedDay?: string };
  usage: { day: string; calls: number };
  /** Passes that failed in a row. */
  failures: number;
  /** The day a problem was last told to the user, so it is said once a day. */
  lastProblemDay?: string;
}

/** Most entries kept in the known-sender cache and the pending digest. */
export const MAX_KNOWN = 2000;
export const MAX_DIGEST = 100;

export function emptyState(): MailWatchState {
  return { accounts: {}, known: {}, digest: { pending: [], skipped: 0 }, usage: { day: "", calls: 0 }, failures: 0 };
}

export function mailWatchStatePath(): string {
  return join(getLaxDir(), "mail-watch.json");
}

export function loadMailWatchState(path: string = mailWatchStatePath()): MailWatchState {
  try {
    if (!existsSync(path)) return emptyState();
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<MailWatchState>;
    const base = emptyState();
    return {
      accounts: raw.accounts && typeof raw.accounts === "object" ? raw.accounts : base.accounts,
      known: raw.known && typeof raw.known === "object" ? raw.known : base.known,
      digest: {
        pending: Array.isArray(raw.digest?.pending) ? raw.digest.pending : [],
        skipped: typeof raw.digest?.skipped === "number" ? raw.digest.skipped : 0,
        ...(raw.digest?.lastPostedDay ? { lastPostedDay: raw.digest.lastPostedDay } : {}),
      },
      usage: raw.usage && typeof raw.usage.day === "string" ? raw.usage : base.usage,
      failures: typeof raw.failures === "number" ? raw.failures : 0,
      ...(raw.lastProblemDay ? { lastProblemDay: raw.lastProblemDay } : {}),
    };
  } catch {
    return emptyState();
  }
}

/** Saves the state, trimming the caches to their caps (oldest out). Mail
 *  senders and subjects are private: the file is the user's only. */
export function saveMailWatchState(state: MailWatchState, path: string = mailWatchStatePath()): void {
  const known = Object.entries(state.known).sort((a, b) => b[1].checkedAt - a[1].checkedAt).slice(0, MAX_KNOWN);
  const pending = state.digest.pending.slice(-MAX_DIGEST);
  const dropped = state.digest.pending.length - pending.length;
  const trimmed: MailWatchState = {
    ...state,
    known: Object.fromEntries(known),
    digest: { ...state.digest, pending, skipped: state.digest.skipped + dropped },
  };
  atomicWriteFileSync(path, JSON.stringify(trimmed), { encoding: "utf-8", mode: 0o600 });
}

/** The local calendar day of `now`, "YYYY-MM-DD". */
export function localDay(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
