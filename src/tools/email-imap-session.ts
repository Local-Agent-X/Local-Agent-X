/**
 * The connection, and every operation that runs over one.
 *
 * Split out of email-imap.ts along the seam that was already there: that module
 * declares the SHAPES callers speak in and publishes one function per
 * operation; this one owns the socket. The lifecycle rule its header argues for
 * — one connect, one lock, one release, one logout, on every path including the
 * error path — is enforced here, because it is only expressible where the
 * client is constructed.
 *
 * `withSession` is the reason this file exists as more than a move. Every
 * operation used to be its own CONNECTION: connect, TLS, AUTH, then logout.
 * `email_delete` needs three of them — the folder list to resolve Trash by role,
 * then the search or the uid existence check, then the move — so against Gmail
 * one delete paid three handshakes at 1-3s apiece, which is where the 5-47s
 * deletes measured in production came from. That cost is in the SHAPE, one
 * connection per call, so the fix has to be a shape that lets a caller say
 * "these operations, together".
 *
 * Deliberately absent: EXPUNGE / permanent deletion (campaign decision E1).
 * Moving to a trash folder is the delete mechanism.
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
  type MimeNode,
} from "./email-body-render.js";
// TYPE-ONLY, and it has to stay that way: email-imap.ts imports this module for
// real, so a value import back would close a runtime cycle. `import type` is
// erased, so there is no cycle to reason about at all.
import type {
  EmailBody,
  EmailHeader,
  EmailPage,
  EmailSummary,
  FlagAction,
  FlagResult,
  ImapCredentials,
  MailboxFolder,
  MoveResult,
} from "./email-imap.js";

/**
 * The mailbox named could not be SELECTed.
 *
 * A TYPE rather than a phrase, because callers have to tell this apart from
 * every other failure and the only alternative was matching prose: the mutate
 * tools classified with `/mailbox|folder|select/i`, which also matched
 * `buildSearchQuery`'s "refusing to build a query that matches the entire
 * mailbox" and rewrote a no-filters refusal into "you picked a container,
 * retry against another folder" — advice that is wrong and that the model
 * cannot act on. Anything thrown from the SELECT is this; nothing else is.
 */
export class MailboxOpenError extends Error {
  constructor(public readonly folder: string, public readonly reason: Error) {
    super(`Could not open the folder "${folder}": ${reason.message}`);
    this.name = "MailboxOpenError";
  }
}

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

/** SELECT a mailbox on an ALREADY-OPEN client and release the lock however the
 *  operation ends. Split from the connection lifecycle because a session takes
 *  one connection and as many locks as it has operations. */
async function onMailbox<T>(client: ImapFlow, folder: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  let lock: MailboxLockObject;
  try {
    lock = await client.getMailboxLock(folder);
  } catch (err) {
    // Classified HERE, where the SELECT actually failed, so no caller has to
    // guess from the wording of a driver message.
    throw new MailboxOpenError(folder, err as Error);
  }
  try {
    return await fn(client);
  } finally {
    lock.release();
  }
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

/**
 * The selected mailbox's UIDVALIDITY, as a string, or "" when the server did
 * not report one.
 *
 * A string because it is only ever compared for equality and carried inside an
 * opaque cursor token; imapflow types it as a BigInt, which neither JSON nor a
 * `===` against a stored value survives. The `typeof` narrowing is not
 * defensiveness for its own sake: a server (or a fake) that omits the field
 * would otherwise stringify `undefined` into a value that compares EQUAL to
 * itself, which would turn "no validity reported" into a false guarantee.
 */
function uidValidityOf(client: ImapFlow): string {
  const box = client.mailbox;
  if (!box) return "";
  const raw: unknown = box.uidValidity;
  if (typeof raw === "bigint" || typeof raw === "number") return String(raw);
  return typeof raw === "string" ? raw : "";
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

/** A resolved match set: every uid the search matched, and the UIDVALIDITY the
 *  mailbox reported while it was being resolved. The two travel together
 *  because a uid outside its validity epoch names different mail. */
export interface UidSearchResult {
  uids: number[];
  uidValidity: string;
}

/** The headers of the uids that are ACTUALLY in the folder, and the mailbox's
 *  UIDVALIDITY at that moment. Uids absent from `headers` are not in the folder
 *  — what that MEANS is the caller's decision, not this layer's. */
export interface ResolvedUids {
  headers: EmailHeader[];
  uidValidity: string;
}

/**
 * Every operation the data layer offers, bound to ONE open connection.
 *
 * The per-operation functions email-imap.ts exports are this interface with
 * exactly one call in it. Same implementation, same lifecycle guarantees; the
 * only difference is how many operations share the handshake.
 */
export interface ImapSession {
  listFolders(): Promise<MailboxFolder[]>;
  fetchMessages(folder: string, uids: number[] | null, limit: number): Promise<EmailPage>;
  fetchHeaders(folder: string, uids: number[]): Promise<EmailHeader[]>;
  /** Takes an ALREADY-COMPILED query, not criteria: `buildSearchQuery` throws on
   *  criteria that would match the whole mailbox, and a caller that wants that
   *  refusal to cost no connection has to compile before the session opens one.
   *  `searchMessages` and `email_delete` both do exactly that. */
  search(folder: string, query: SearchObject, limit: number): Promise<EmailPage>;
  /** SEARCH only: the WHOLE match set as uids, with no message fetch. What a
   *  delete needs — it acts on uids and only ever needs the envelopes of the
   *  page it is about to move, not the raw bytes of every match. */
  searchUids(folder: string, query: SearchObject): Promise<UidSearchResult>;
  /** Envelope-only FETCH of an explicit uid set, plus the mailbox's
   *  UIDVALIDITY. `fetchHeaders` is this without the validity. */
  resolveUids(folder: string, uids: number[]): Promise<ResolvedUids>;
  fetchBody(folder: string, uid: number): Promise<EmailBody>;
  moveMessages(folder: string, uids: number[], destination: string): Promise<MoveResult>;
  setFlags(folder: string, uids: number[], flags: string[], action: FlagAction): Promise<FlagResult>;
}

/** Hand out the connection, opening it if this is the first operation to need
 *  one. Everything a session does goes through this and nothing else. */
type OpenConnection = () => Promise<ImapFlow>;

/** The ONE implementation of every operation, over a connection it does not
 *  own. `withSession` owns the connection; the exported wrappers own nothing. */
function sessionOn(open: OpenConnection): ImapSession {
  /** Run `fn` inside a SELECT of `folder` on this session's connection. */
  const inFolder = async <T>(folder: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> =>
    onMailbox(await open(), folder, fn);

  /** The ONE envelope resolve. `fetchHeaders` is this with the validity
   *  dropped, so the two can never disagree about which uids are present. */
  const resolveUids = (folder: string, uids: number[]): Promise<ResolvedUids> =>
    inFolder(folder, async (client) => {
      const headers: EmailHeader[] = [];
      if (uids.length > 0) {
        for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
          headers.push(toHeader(msg as unknown as FetchedMessage));
        }
      }
      return { headers, uidValidity: uidValidityOf(client) };
    });

  return {
    async listFolders(): Promise<MailboxFolder[]> {
      // No SELECT: LIST is a connection-level command, and the folder it names
      // is usually not the folder the caller then works in.
      const client = await open();
      const boxes = await client.list();
      return boxes.map((box) => ({
        path: box.path,
        name: box.name,
        specialUse: box.specialUse || null,
        subscribed: Boolean(box.subscribed),
      }));
    },

    fetchMessages(folder: string, uids: number[] | null, limit: number): Promise<EmailPage> {
      return inFolder(folder, (client) => fetchPage(client, uids, limit));
    },

    async fetchHeaders(folder: string, uids: number[]): Promise<EmailHeader[]> {
      // Decided from the arguments, so an empty set still costs no handshake.
      if (uids.length === 0) return [];
      return (await resolveUids(folder, uids)).headers;
    },

    resolveUids,

    search(folder: string, query: SearchObject, limit: number): Promise<EmailPage> {
      return inFolder(folder, async (client) => {
        const found = await client.search(query, { uid: true });
        return fetchPage(client, Array.isArray(found) ? found : [], limit);
      });
    },

    searchUids(folder: string, query: SearchObject): Promise<UidSearchResult> {
      return inFolder(folder, async (client) => {
        const found = await client.search(query, { uid: true });
        return { uids: Array.isArray(found) ? found : [], uidValidity: uidValidityOf(client) };
      });
    },

    fetchBody(folder: string, uid: number): Promise<EmailBody> {
      return inFolder(folder, async (client) => {
        const [msg] = await client.fetchAll(String(uid), { uid: true, envelope: true, bodyStructure: true }, { uid: true });
        if (!msg) throw new Error(`Message uid ${uid} not found in ${folder}`);
        const structure = msg.bodyStructure as MimeNode | undefined;
        // toHeader, not toSummary: this fetch asks for the envelope and
        // structure, not `source`, so a snippet derived here would be "" on
        // every real result.
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
    },

    async moveMessages(folder: string, uids: number[], destination: string): Promise<MoveResult> {
      // An empty move is decided from the arguments, so it never reaches
      // `open()` and never costs a handshake.
      if (uids.length === 0) return { requested: 0, moved: 0, confirmed: true, destination };
      return inFolder(folder, async (client) => {
        const result = await client.messageMove(uids, destination, { uid: true });
        // A refusal is a confirmed zero, not an unknown.
        if (!result) return { requested: uids.length, moved: 0, confirmed: true, destination };
        const uidMap = (result as { uidMap?: Map<number, number> }).uidMap;
        if (uidMap instanceof Map && uidMap.size > 0) {
          return { requested: uids.length, moved: uidMap.size, confirmed: true, destination };
        }
        return { requested: uids.length, moved: uids.length, confirmed: false, destination };
      });
    },

    async setFlags(folder: string, uids: number[], flags: string[], action: FlagAction): Promise<FlagResult> {
      if (uids.length === 0 || flags.length === 0) return { updated: 0, flags, action };
      return inFolder(folder, async (client) => {
        const ok = action === "add"
          ? await client.messageFlagsAdd(uids, flags, { uid: true })
          : await client.messageFlagsRemove(uids, flags, { uid: true });
        return { updated: ok ? uids.length : 0, flags, action };
      });
    },
  };
}

/**
 * Run several operations on ONE connection.
 *
 * The connection is opened on FIRST USE, not on entry. An operation decidable
 * from its arguments alone — an empty uid set, criteria a caller compiled and
 * rejected — must cost no handshake, and making that structural here is both
 * smaller and harder to regress than repeating the guard in every wrapper.
 *
 * Exactly one connect, one logout and one close per session, on every path:
 *   · nothing opened  → nothing closed;
 *   · connect throws  → the socket is closed where it is created, the rejected
 *     promise is memoised so no later operation retries, and the teardown below
 *     sees the rejection and does NOT close a second time;
 *   · fn throws       → `finally` still runs the teardown.
 * The promise (not the client) is memoised so two operations racing to be first
 * cannot each open a connection and leak one of them.
 */
export async function withSession<T>(cfg: ImapCredentials, fn: (session: ImapSession) => Promise<T>): Promise<T> {
  // Held on an object rather than in a bare `let` so that the teardown below
  // reads what the closure actually assigned: TypeScript narrows a local `let`
  // to its initialiser and does not track writes made inside `open`.
  const held: { connection: Promise<ImapFlow> | null } = { connection: null };
  const open: OpenConnection = () => (held.connection ??= (async () => {
    const client = newClient(cfg);
    try {
      await client.connect();
    } catch (err) {
      client.close();
      throw err;
    }
    return client;
  })());
  try {
    return await fn(sessionOn(open));
  } finally {
    // `connect()` already closed its own socket on the failure path, so a
    // rejection here is nothing left to clean up.
    if (held.connection) await held.connection.then(disconnect, () => {});
  }
}
