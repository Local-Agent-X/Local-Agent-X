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
 * Deliberately absent: EXPUNGE / permanent deletion (campaign decision E1).
 * Moving to a trash folder is the delete mechanism — it has a rollback (move it
 * back), and on Gmail a \Deleted flag plus expunge removes a LABEL rather than
 * trashing the mail, which is not what any caller means by "delete".
 */
import { ImapFlow, type MailboxLockObject, type SearchObject } from "imapflow";
import {
  BODY_BYTE_LIMIT,
  capBody,
  collectAttachments,
  decodeBuffer,
  extractSnippet,
  formatAddress,
  htmlToText,
  normalizePlainText,
  readCapped,
  selectBodyPart,
  type AttachmentInfo,
  type MimeNode,
} from "./email-body-render.js";

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

/**
 * Search predicates, mapped onto imapflow's criteria object rather than
 * hand-rolled IMAP search strings. Fields combine with AND; `anyOf` expresses
 * OR. "everything from noreply@x older than a year" is
 * `{ from: "noreply@x", before: <date> }`.
 */
export interface EmailSearchCriteria {
  from?: string;
  subject?: string;
  /** Matches the message body text. */
  body?: string;
  /** Matches anywhere in headers or body. */
  text?: string;
  unreadOnly?: boolean;
  /** Received strictly before this date. */
  before?: Date;
  /** Received on or after this date. */
  since?: Date;
  /** At least one of these must match. Combines with the AND fields above. */
  anyOf?: EmailSearchCriteria[];
}

export type FlagAction = "add" | "remove";

const ANY_OF_MAX_DEPTH = 4;

function newClient(cfg: ImapCredentials): ImapFlow {
  return new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
}

/** Close a client exactly once, however the operation ended. `logout` is the
 *  polite path; `close` is unconditional so a half-dead socket still goes away
 *  instead of leaking a connection on the error path. */
async function disconnect(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    // Connection already broken — nothing to say politely.
  } finally {
    client.close();
  }
}

async function withConnection<T>(cfg: ImapCredentials, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = newClient(cfg);
  try {
    await client.connect();
  } catch (err) {
    client.close();
    throw err;
  }
  try {
    return await fn(client);
  } finally {
    await disconnect(client);
  }
}

async function withMailbox<T>(cfg: ImapCredentials, folder: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  return withConnection(cfg, async (client) => {
    let lock: MailboxLockObject | undefined;
    try {
      lock = await client.getMailboxLock(folder);
      return await fn(client);
    } finally {
      lock?.release();
    }
  });
}

type FetchedMessage = {
  uid: number;
  envelope?: { from?: { name?: string; address?: string }[]; subject?: string; date?: Date; messageId?: string };
  source?: Buffer;
};

/** Everything derivable from the envelope alone — no `source` fetch needed. */
function toHeader(msg: FetchedMessage): Omit<EmailSummary, "snippet"> {
  const env = msg.envelope;
  return {
    uid: msg.uid,
    from: formatAddress(env?.from?.[0]),
    subject: env?.subject || "(no subject)",
    date: env?.date ? new Date(env.date).toISOString() : "unknown",
    messageId: env?.messageId || null,
  };
}

/** Header plus preview. Only call where the fetch asked for `source: true` —
 *  otherwise the snippet is silently empty. */
function toSummary(msg: FetchedMessage): EmailSummary {
  return { ...toHeader(msg), snippet: extractSnippet(msg.source?.toString("utf-8") || "") };
}

/** A FRESH empty page every time. It was once a shared const returned by
 *  reference, so a caller sorting or annotating `page.messages` in place — the
 *  natural thing — poisoned every later empty result, including ones feeding a
 *  move. */
function emptyPage(): EmailPage {
  return { messages: [], total: 0, returned: 0, truncated: false };
}

/**
 * Fetch a page inside an already-locked mailbox.
 *
 * `uids === null` means "the most recent `limit` messages", expressed as a
 * SEQUENCE range anchored to the mailbox size. It used to be the string `"*"`,
 * which in IMAP means the LAST message — so `email_read` returned exactly one
 * message whatever `limit` said, and the `range || "1:*"` fallback never fired
 * because `"*"` is truthy.
 *
 * When the set is larger than `limit` the page is the NEWEST `limit` — the tail
 * of the uid set and the tail of the sequence range. "The 10 oldest" and "the
 * 10 newest" are different mailboxes once a caller moves them.
 */
async function fetchPage(client: ImapFlow, uids: number[] | null, limit: number): Promise<EmailPage> {
  const size = Math.max(1, Math.floor(limit));
  let total: number;
  let range: string | number[];
  let byUid: boolean;
  if (uids === null) {
    total = client.mailbox ? client.mailbox.exists : 0;
    if (total === 0) return emptyPage();
    range = `${Math.max(1, total - size + 1)}:${total}`;
    byUid = false;
  } else {
    total = uids.length;
    if (total === 0) return emptyPage();
    range = uids.slice(-size);
    byUid = true;
  }
  const messages: EmailSummary[] = [];
  for await (const msg of client.fetch(range, { uid: true, envelope: true, source: true }, { uid: byUid })) {
    if (messages.length >= size) break;
    messages.push(toSummary(msg as unknown as Parameters<typeof toSummary>[0]));
  }
  return { messages, total, returned: messages.length, truncated: total > messages.length };
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
  return withMailbox(cfg, folder, (client) => fetchPage(client, uids, limit));
}

/**
 * Compile criteria into an imapflow search object.
 *
 * THROWS rather than widening. Criteria that reduce to nothing — `{}`,
 * `anyOf: []`, `anyOf: [{}]`, or nesting past `ANY_OF_MAX_DEPTH` — used to
 * become `{ all: true }`, and inside an `or` branch a single `all: true`
 * alternative makes the WHOLE disjunction match every message in the mailbox.
 * A caller that computes criteria from user input and gets none is not asking
 * for the whole mailbox; the verbs downstream of this are a move and a delete,
 * so the empty case has to fail where it happens rather than at the target.
 * "Everything recent" has an honest expression already: `fetchMessages` with a
 * null uid set.
 */
export function buildSearchQuery(criteria: EmailSearchCriteria, depth = 0): SearchObject {
  const query: SearchObject = {};
  if (criteria.from) query.from = criteria.from;
  if (criteria.subject) query.subject = criteria.subject;
  if (criteria.body) query.body = criteria.body;
  if (criteria.text) query.text = criteria.text;
  if (criteria.unreadOnly) query.seen = false;
  if (criteria.before) query.before = criteria.before;
  if (criteria.since) query.since = criteria.since;
  const alternatives = criteria.anyOf?.filter((c) => c && Object.keys(c).length > 0) ?? [];
  if (alternatives.length > 0) {
    if (depth >= ANY_OF_MAX_DEPTH) {
      throw new Error(`Search criteria nest anyOf deeper than ${ANY_OF_MAX_DEPTH} levels; flatten them rather than searching a wider set than was asked for.`);
    }
    // Always an `or`, even for one alternative: assigning the single
    // alternative's keys onto `query` overwrote same-named AND siblings, so
    // `{ from: alice, anyOf: [{ from: bob }] }` searched for bob alone. A
    // one-element `or` is walked inline by imapflow's compiler, which is
    // exactly the AND the documented contract promises.
    query.or = alternatives.map((c) => buildSearchQuery(c, depth + 1));
  }
  if (Object.keys(query).length === 0) {
    throw new Error("Empty search criteria: refusing to build a query that matches the entire mailbox. Pass at least one predicate, or use fetchMessages for the most recent messages.");
  }
  return query;
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
  return withMailbox(cfg, folder, async (client) => {
    const found = await client.search(query, { uid: true });
    return fetchPage(client, Array.isArray(found) ? found : [], limit);
  });
}

/** Read one message's full body as readable text. */
export async function fetchBody(cfg: ImapCredentials, folder: string, uid: number): Promise<EmailBody> {
  return withMailbox(cfg, folder, async (client) => {
    const [msg] = await client.fetchAll(String(uid), { uid: true, envelope: true, bodyStructure: true }, { uid: true });
    if (!msg) throw new Error(`Message uid ${uid} not found in ${folder}`);
    const structure = msg.bodyStructure as MimeNode | undefined;
    // toHeader, not toSummary: this fetch asks for the envelope and structure,
    // not `source`, so a snippet derived here would be "" on every real result.
    const summary = toHeader(msg as unknown as FetchedMessage);
    const attachments = collectAttachments(structure);
    const selected = selectBodyPart(structure);
    if (!selected) return { ...summary, body: "", contentType: null, truncated: false, attachments };
    const download = await client.download(String(uid), selected.part, { uid: true });
    const { buf, truncated: cutOnWire } = await readCapped(download.content, BODY_BYTE_LIMIT);
    const decoded = decodeBuffer(buf, download.meta?.charset);
    const rendered = selected.isHtml ? htmlToText(decoded) : normalizePlainText(decoded);
    const capped = capBody(rendered);
    return {
      ...summary,
      body: capped.text,
      contentType: selected.isHtml ? "text/html" : "text/plain",
      truncated: capped.truncated || cutOnWire,
      attachments,
    };
  });
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
  if (uids.length === 0) return { requested: 0, moved: 0, confirmed: true, destination };
  return withMailbox(cfg, folder, async (client) => {
    const result = await client.messageMove(uids, destination, { uid: true });
    // A refusal is a confirmed zero, not an unknown.
    if (!result) return { requested: uids.length, moved: 0, confirmed: true, destination };
    const uidMap = (result as { uidMap?: Map<number, number> }).uidMap;
    if (uidMap instanceof Map && uidMap.size > 0) {
      return { requested: uids.length, moved: uidMap.size, confirmed: true, destination };
    }
    return { requested: uids.length, moved: uids.length, confirmed: false, destination };
  });
}

/** Add or remove IMAP flags (`\Seen`, `\Flagged`, …) on a UID set. */
export async function setFlags(
  cfg: ImapCredentials,
  folder: string,
  uids: number[],
  flags: string[],
  action: FlagAction,
): Promise<{ updated: number; flags: string[]; action: FlagAction }> {
  if (uids.length === 0 || flags.length === 0) return { updated: 0, flags, action };
  return withMailbox(cfg, folder, async (client) => {
    const ok = action === "add"
      ? await client.messageFlagsAdd(uids, flags, { uid: true })
      : await client.messageFlagsRemove(uids, flags, { uid: true });
    return { updated: ok ? uids.length : 0, flags, action };
  });
}

/** List the account's folders so callers stop guessing at `[Gmail]/Trash`. */
export async function listFolders(cfg: ImapCredentials): Promise<MailboxFolder[]> {
  return withConnection(cfg, async (client) => {
    const boxes = await client.list();
    return boxes.map((box) => ({
      path: box.path,
      name: box.name,
      specialUse: box.specialUse || null,
      subscribed: Boolean(box.subscribed),
    }));
  });
}
