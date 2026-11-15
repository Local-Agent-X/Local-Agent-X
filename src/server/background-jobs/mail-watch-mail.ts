// The mail watcher's read of the user's mailboxes: which accounts there are,
// what arrived since the last pass, and whether a sender is someone the user
// has written to. Read-only by construction: it calls only the search, fetch
// and list operations of src/tools/email-imap.ts, the one owner of IMAP.

import { getImapConfig, getOwnEmailAddresses, imapConfigured } from "../../tools/email-config.js";
import { withSession, type EmailSummary, type ImapCredentials, type ImapSession } from "../../tools/email-imap.js";
import type { MailCheckpoint, MailWatchState } from "./mail-watch-state.js";

/** One mailbox the watcher reads. Every connected account is one; LAX
 *  connects a single IMAP account today, and a second is one more entry. */
export interface MailAccount {
  id: string;
  creds: ImapCredentials;
}

export function mailAccounts(): MailAccount[] {
  if (!imapConfigured()) return [];
  const cfg = getImapConfig();
  return typeof cfg === "string" ? [] : [{ id: cfg.user.toLowerCase(), creds: cfg }];
}

/** Messages read per account per pass; anything beyond is counted, not read. */
export const MAX_PER_PASS = 30;
/** How far back the very first pass (or one after the mailbox was rebuilt) looks. */
export const FIRST_LOOK_MS = 24 * 60 * 60 * 1000;
/** How long a "has never written to them" answer is trusted. */
export const UNKNOWN_RECHECK_MS = 24 * 60 * 60 * 1000;

const INBOX = "INBOX";

export interface NewMail {
  messages: EmailSummary[];
  /** Where the next pass starts. */
  checkpoint: MailCheckpoint;
  /** New messages past MAX_PER_PASS that were not read. */
  skipped: number;
}

/** The address in "Name <addr>" (or a bare address), lowercased; "" when none. */
export function addressOf(from: string): string {
  const angled = /<([^<>]*)>/.exec(from);
  const addr = (angled ? angled[1] : from).trim().toLowerCase();
  return addr.includes("@") ? addr : "";
}

/** Mail that arrived after `prior`, newest MAX_PER_PASS of it. Without a
 *  usable checkpoint (first pass, or the server renumbered the mailbox) it
 *  reads the last FIRST_LOOK_MS instead of the whole mailbox. */
export async function readNewMail(session: ImapSession, prior: MailCheckpoint | undefined, now: Date, folder: string = INBOX): Promise<NewMail> {
  let found = prior
    ? await session.searchUids(folder, { uid: `${prior.lastUid + 1}:*` })
    : await session.searchUids(folder, { since: new Date(now.getTime() - FIRST_LOOK_MS) });
  let after = prior?.lastUid ?? 0;
  let fromScratch = !prior;
  if (prior && found.uidValidity !== prior.uidValidity) {
    found = await session.searchUids(folder, { since: new Date(now.getTime() - FIRST_LOOK_MS) });
    after = 0;
    fromScratch = true;
  }
  // "N:*" always matches the newest message, even when it is older than N.
  const fresh = found.uids.filter((u) => u > after).sort((a, b) => a - b);
  // Starting over, the mark is the newest message in the box, read or not:
  // with a mark of 0 the next pass's "1:*" would be the whole mailbox.
  const newest = fromScratch ? (await session.searchUids(folder, { uid: "*" })).uids : [];
  const picked = fresh.slice(-MAX_PER_PASS);
  const page = picked.length > 0 ? await session.fetchMessages(folder, picked, picked.length) : { messages: [] };
  return {
    messages: page.messages,
    checkpoint: { uidValidity: found.uidValidity, lastUid: fresh.concat(newest).reduce((m, u) => Math.max(m, u), after) },
    skipped: fresh.length - picked.length,
  };
}

/**
 * Whether the user has sent mail to each sender: a search of their Sent
 * folder, cached in `state.known` (a "yes" for good, a "no" for a day). The
 * user's own addresses are never "someone they know"; mail from themselves is
 * not news. Without a Sent folder every answer is "no".
 */
export async function knownSenders(
  session: ImapSession,
  senders: string[],
  state: MailWatchState,
  now: number,
): Promise<Set<string>> {
  const own = new Set(getOwnEmailAddresses());
  const known = new Set<string>();
  const toCheck: string[] = [];
  for (const addr of new Set(senders.filter((s) => s && !own.has(s)))) {
    const cached = state.known[addr];
    if (cached?.known) known.add(addr);
    else if (!cached || now - cached.checkedAt > UNKNOWN_RECHECK_MS) toCheck.push(addr);
  }
  if (toCheck.length === 0) return known;
  const sent = (await session.listFolders()).find((f) => f.specialUse === "\\Sent")?.path;
  for (const addr of toCheck) {
    const wrote = sent ? (await session.searchUids(sent, { to: addr })).uids.length > 0 : false;
    state.known[addr] = { known: wrote, checkedAt: now };
    if (wrote) known.add(addr);
  }
  return known;
}

/** One connection for the whole pass over an account. Swappable in tests. */
export type MailSessionRunner = <T>(creds: ImapCredentials, fn: (s: ImapSession) => Promise<T>) => Promise<T>;
export const defaultMailSession: MailSessionRunner = withSession;
