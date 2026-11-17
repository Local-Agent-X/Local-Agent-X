// What LAX has emailed, at <lax data dir>/email-sent.json: one entry per send
// that went out (email_send records it after the server accepted it). Every
// chat, channel and background run sends through the one tool, so this is the
// one record a new chat can check before it writes to someone again
// (email-repeat-check.ts). Kept for REPEAT_WINDOW_MS; nothing else reads it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { atomicWriteFileSync } from "../util/json-store.js";

export interface SentEmail {
  at: number;
  /** Every address it went to (to, cc, bcc), lower-case. */
  recipients: string[];
  subject: string;
  /** The start of the plain-text body, enough to compare with a new draft. */
  excerpt: string;
  messageId: string;
  inReplyTo: string | null;
  /** The composed email's fingerprint: an identical re-send matches it. */
  fingerprint: string;
}

/** How far back a new email is compared with what was sent. */
export const REPEAT_WINDOW_MS = 48 * 60 * 60 * 1000;
const EXCERPT_CHARS = 2000;
const MAX_ENTRIES = 200;

function path(): string {
  return join(getLaxDir(), "email-sent.json");
}

/** Bare, lower-case addresses from a header-style list ("Ann <a@x.com>, b@y.com"). */
export function addressesIn(list: string): string[] {
  return [...list.matchAll(/[^\s<>,;"]+@[^\s<>,;"]+/g)].map((m) => m[0].toLowerCase());
}

export function loadSent(now = Date.now()): SentEmail[] {
  try {
    if (!existsSync(path())) return [];
    const raw = JSON.parse(readFileSync(path(), "utf-8")) as { sent?: SentEmail[] };
    return (raw.sent ?? []).filter((e) => now - e.at < REPEAT_WINDOW_MS);
  } catch {
    // An unreadable log only costs the repeat check its memory.
    return [];
  }
}

export function recordSent(entry: Omit<SentEmail, "excerpt"> & { text: string }): void {
  const { text, ...rest } = entry;
  const sent = [...loadSent(entry.at), { ...rest, excerpt: text.trim().slice(0, EXCERPT_CHARS) }].slice(-MAX_ENTRIES);
  atomicWriteFileSync(path(), JSON.stringify({ sent }), { encoding: "utf-8", mode: 0o600 });
}

/** The latest email sent to any of these addresses within the window. */
export function lastSentTo(recipients: string[], now = Date.now()): SentEmail | null {
  const wanted = new Set(recipients);
  const hits = loadSent(now).filter((e) => e.recipients.some((r) => wanted.has(r)));
  return hits.length ? hits[hits.length - 1]! : null;
}
