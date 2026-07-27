/**
 * The single owner of IMAP access.
 *
 * Every connection, mailbox lock and logout for the email tools happens here —
 * tool files call these functions and never construct an ImapFlow. That is not
 * tidiness: the three former connection sites each had their own lifecycle, and
 * one of them logged out INSIDE the lock and then released a lock on a
 * logged-out client. One connect, one lock, one release, one logout, on every
 * path including the error path, is expressible only if one module owns it.
 *
 * Two shapes, ONE implementation. `withSession` runs any number of operations
 * on one connection; the per-operation functions below are that same session
 * with exactly one operation in it. A caller that needs several — `email_delete`
 * needs the folder list, then a search or an existence check, then the move —
 * takes a session and pays for one handshake instead of three.
 *
 * The socket itself lives one file over, in email-imap-session.ts: the 400-LOC
 * rule forced a split and that is the seam it was already on. This module stays
 * the ONE import site for callers — everything a tool needs is exported or
 * re-exported here, and no tool file imports imapflow or the session module.
 *
 * Deliberately absent: EXPUNGE / permanent deletion (campaign decision E1).
 * Moving to a trash folder is the delete mechanism — it has a rollback (move it
 * back), and on Gmail a \Deleted flag plus expunge removes a LABEL rather than
 * trashing the mail, which is not what any caller means by "delete".
 */
import { withSession } from "./email-imap-session.js";
import { buildSearchQuery, type EmailSearchCriteria } from "./email-search-query.js";
import type { AttachmentInfo } from "./email-body-render.js";

// The query compiler lives in its own leaf module (it needs no connection) but
// is re-exported here so that email-imap.ts stays the ONE import site for IMAP.
export { buildSearchQuery, SearchCriteriaError, type EmailSearchCriteria } from "./email-search-query.js";
// Likewise the session: `withSession` and the error the SELECT throws are part
// of this seam, not a second one.
export {
  withSession,
  MailboxOpenError,
  type ImapSession,
  type ResolvedUids,
  type UidSearchResult,
} from "./email-imap-session.js";
// A caller that compiles a query up front (to refuse before connecting) needs
// the compiled type, and must not reach into imapflow for it.
export type { SearchObject } from "imapflow";

export interface ImapCredentials { host: string; port: number; user: string; pass: string }

/** One message as the list verbs report it. `uid` is the handle every mutating
 *  verb needs, so it is not optional — without it a caller can list mail and
 *  act on none of it. `messageId` comes free with the envelope IMAP already
 *  returns (no extra fetch), and is what reply threading needs for
 *  In-Reply-To/References. */
export interface EmailSummary {
  uid: number;
  from: string;
  subject: string;
  date: string;
  messageId: string | null;
  snippet: string;
}

/**
 * A PAGE of messages, never a bare array.
 *
 * `total` is how many messages actually matched; `returned` is how many are in
 * `messages`. A caller that ignores the difference is choosing to, rather than
 * being unable to see it — which matters because this shape is the input to a
 * move/delete: "10 of 4,000" and "10" look identical in a bare array.
 */
export interface EmailPage {
  messages: EmailSummary[];
  total: number;
  returned: number;
  truncated: boolean;
}

/**
 * One message with its text. Deliberately NOT `extends EmailSummary`: keeping
 * `snippet` would mean fetching the whole raw message (`source: true`,
 * uncapped) beside a body already downloaded and capped — megabytes for a
 * 200-character preview of text the caller is holding. It was also a lie in
 * practice: this fetch never requested `source`, so the field was `""` on
 * every real result while the type promised a preview.
 */
export interface EmailBody extends Omit<EmailSummary, "snippet"> {
  /** Readable text: the text/plain part when present, else the HTML part
   *  rendered to text. Empty when the message has no textual part. */
  body: string;
  /** Which part the body came from, or null when there was no textual part. */
  contentType: "text/plain" | "text/html" | null;
  /** True when the body hit the size cap and is cut. */
  truncated: boolean;
  /** Attachment metadata only — names, types, sizes. Never bytes. */
  attachments: AttachmentInfo[];
}

export interface MailboxFolder {
  path: string;
  name: string;
  specialUse: string | null;
  subscribed: boolean;
}

export type FlagAction = "add" | "remove";

/** What a flag change reports back: how many messages it was applied to, and
 *  which change it was. `updated` is 0 when the server refused. */
export interface FlagResult {
  updated: number;
  flags: string[];
  action: FlagAction;
}

/**
 * List messages in a folder.
 *
 * `uids` is an explicit UID set, or null for the most recent `limit` messages.
 */
export async function fetchMessages(
  cfg: ImapCredentials,
  folder: string,
  uids: number[] | null,
  limit: number,
): Promise<EmailPage> {
  return withSession(cfg, (session) => session.fetchMessages(folder, uids, limit));
}

/** A message identified but not read: everything the envelope already carries,
 *  and no body. What a caller needs to NAME a message it is about to act on. */
export type EmailHeader = Omit<EmailSummary, "snippet">;

/**
 * Resolve an explicit UID set inside one folder: the header of every uid that
 * is actually THERE, and nothing for the ones that are not.
 *
 * IMAP uids are per-mailbox. A uid that a caller obtained by searching
 * `receipts` names a DIFFERENT message in INBOX, or no message at all, so any
 * verb taking uids on trust against a folder argument acts on a set the caller
 * never saw. This is the check that makes that impossible: envelope-only (no
 * `source`, so it costs one small FETCH, not the mail itself), returning
 * headers rather than a bare boolean so the caller can also say WHICH messages
 * it touched.
 *
 * This is its own SELECT and its own FETCH, so a caller using it as a pre-flight
 * check for a later move is separated from that move by a window — narrower now
 * that `email_delete` runs both on one session, but still a window. Within one
 * UIDVALIDITY that window is SAFE and not merely lucky: IMAP forbids uid reuse
 * inside a validity epoch (RFC 3501 §2.3.1.1), so the only thing that can happen
 * to a uid in the gap is that it DISAPPEARS. The unhandled case — a UIDVALIDITY
 * change landing inside the gap, after which the checked uids name different
 * mail — was a recorded residual and is now CLOSED for `email_delete`, which
 * uses `resolveUids` instead and threads the validity through
 * email-delete-sweep.ts. This function reports no validity, so a caller that
 * needs the guarantee must use `resolveUids`.
 */
export async function fetchHeaders(cfg: ImapCredentials, folder: string, uids: number[]): Promise<EmailHeader[]> {
  return withSession(cfg, (session) => session.fetchHeaders(folder, uids));
}

/** Search a folder and return the matching page — one connection for both the
 *  search and the fetch, where the old tool opened two. The query is compiled
 *  BEFORE connecting, so empty criteria cost no connection, the way an empty
 *  move does. */
export async function searchMessages(
  cfg: ImapCredentials,
  folder: string,
  criteria: EmailSearchCriteria,
  limit: number,
): Promise<EmailPage> {
  const query = buildSearchQuery(criteria);
  return withSession(cfg, (session) => session.search(folder, query, limit));
}

/** Read one message's full body as readable text. */
export async function fetchBody(cfg: ImapCredentials, folder: string, uid: number): Promise<EmailBody> {
  return withSession(cfg, (session) => session.fetchBody(folder, uid));
}

/**
 * The outcome of a move, with the count the SERVER confirmed separated from
 * the count that was asked for.
 *
 * `moved` used to be `uids.length` on any non-false result — a 3-uid move the
 * server only partly performed reported 3, and this is the delete mechanism
 * (decision E1). Over-reporting a delete is the worst thing this layer could
 * do, so `moved` is now the size of the UIDPLUS `uidMap` when the server sends
 * one. Servers without UIDPLUS say nothing about which messages moved; there
 * `moved` falls back to the requested count and `confirmed` is false, which is
 * the honest statement "accepted, unenumerated" rather than a fake receipt.
 */
export interface MoveResult {
  /** How many uids the caller asked to move. */
  requested: number;
  /** How many the server confirmed, or `requested` when `confirmed` is false. */
  moved: number;
  /** True when `moved` came from the server rather than from the request. */
  confirmed: boolean;
  destination: string;
}

/** Relocate a UID set to another folder. Per decision E1 this is also the
 *  delete mechanism: moving to the account's trash folder is reversible and
 *  means the same thing on every provider, which expunge does not. */
export async function moveMessages(
  cfg: ImapCredentials,
  folder: string,
  uids: number[],
  destination: string,
): Promise<MoveResult> {
  return withSession(cfg, (session) => session.moveMessages(folder, uids, destination));
}

/** Add or remove IMAP flags (`\Seen`, `\Flagged`, …) on a UID set. */
export async function setFlags(
  cfg: ImapCredentials,
  folder: string,
  uids: number[],
  flags: string[],
  action: FlagAction,
): Promise<FlagResult> {
  return withSession(cfg, (session) => session.setFlags(folder, uids, flags, action));
}

/** List the account's folders so callers stop guessing at `[Gmail]/Trash`. */
export async function listFolders(cfg: ImapCredentials): Promise<MailboxFolder[]> {
  return withSession(cfg, (session) => session.listFolders());
}
