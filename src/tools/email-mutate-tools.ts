/**
 * The two mailbox-mutating verbs: `email_delete` and `email_mark`.
 *
 * ── Deletion is a MOVE to Trash (campaign decision E1) ──────────────────────
 * There is no permanent-removal path in this file, and none in any of its
 * siblings: `email-imap.test.ts` asserts that against the SOURCE of every
 * `email-*.ts` module, so adding one fails on the commit that adds it.
 *
 * Two reasons, and the second is the load-bearing one:
 *
 *  1. Reversibility by construction. `risk: "destructive"` maps through
 *     src/autonomy/profiles.ts to `allow-with-rollback` on two profiles, and
 *     src/autonomy/rollback.ts implements rollback by backing up a FILE PATH,
 *     which an IMAP message does not have. Making the operation undoable by
 *     what it IS — the message is still there, in Trash, and can be moved back
 *     — lets this tool inherit that risk class truthfully instead of inventing
 *     mailbox-shaped rollback machinery that the autonomy layer cannot see.
 *
 *  2. On Gmail, setting the deleted flag and purging removes a LABEL. It does
 *     not trash the message. A flag-based delete would return success and do
 *     nothing the user asked for — the single worst outcome available to a tool
 *     in this class.
 *
 * KNOWN LIMIT, stated so a future reader does not read the source assertion as
 * proving more than it does: imapflow EMULATES MOVE as COPY + delete-flag +
 * purge on a server that does not advertise the MOVE capability
 * (node_modules/imapflow/lib/commands/move.js:33-37). E1 therefore holds for
 * OUR source and for the wire on every server with MOVE — which includes Gmail
 * — but not for the wire on a server without it. The COPY lands BEFORE the
 * removal there, so the message exists in Trash either way and the rollback
 * argument above survives; what does not survive on such a server is the claim
 * that no purge command was ever sent. Do not "fix" this by reaching around
 * imapflow: a hand-rolled COPY would put the failure back in our own code.
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { getImapConfig, imapConfigured } from "./email-config.js";
import { argReader } from "./email-tool-args.js";
import {
  listFolders,
  moveMessages,
  searchMessages,
  setFlags,
  type EmailSearchCriteria,
  type ImapCredentials,
  type MailboxFolder,
} from "./email-imap.js";

/* `imapConfigured` is the shared export from the config store (C6), imported —
 * not re-inlined — so all six IMAP tools are gated by referentially the same
 * predicate and a copy cannot drift. */

/**
 * The most messages either verb will act on in ONE call.
 *
 * This is not a page size, it is a blast-radius ceiling. `searchMessages`
 * returns a PAGE, so the set this tool can enumerate is bounded anyway; the cap
 * makes the bound a stated rule rather than an accident of the default limit.
 * A caller wanting to clear 4,000 messages must narrow the window (by sender,
 * by month) and come back — every call is separately gated by the destructive
 * risk class, which is the point.
 */
const MAX_BATCH = 200;
const DEFAULT_BATCH = 50;

/** RFC 6154's role attribute for the trash folder. The ONLY way this file is
 *  allowed to find it: names are localised ("Bin", "Papierkorb") and namespaced
 *  ("[Gmail]/Trash", "INBOX.Trash"), so any name match is a provider-specific
 *  guess that fails silently on the providers it was not written for. */
const TRASH_ROLE = "\\Trash";

interface Resolved {
  cfg: ImapCredentials;
  folders: MailboxFolder[];
  /** The server's own spelling of the requested source folder. */
  folder: string;
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}

/** Resolve credentials, the folder list, and the source folder's real path.
 *  Returns a ToolResult when it cannot — every failure here is a refusal to
 *  act, never a guess. */
async function resolve(cfg: ImapCredentials, requested: string): Promise<Resolved | ToolResult> {
  let folders: MailboxFolder[];
  try {
    folders = await listFolders(cfg);
  } catch (err) {
    return fail(`Could not list the mailbox's folders, so the folder to act on could not be verified: ${(err as Error).message}`);
  }
  // Case-insensitive, because INBOX is case-insensitive by RFC and models
  // routinely write "inbox". The SERVER's spelling is what gets used.
  const match = folders.find((f) => f.path.toLowerCase() === requested.toLowerCase());
  if (!match) {
    return fail(
      `This mailbox has no folder named "${requested}". Call email_folders and pass a \`path\` from it verbatim. `
      + `Nothing was changed.`,
    );
  }
  return { cfg, folders, folder: match.path };
}

/** Turn a mailbox-open failure into a sentence that names the folder. A
 *  `\Noselect` container (Gmail exposes "[Gmail]" as one) is a real folder in
 *  the LIST output that cannot be SELECTed, and `listFolders` drops `box.flags`
 *  so we cannot see the attribute to pre-empt it. */
function openFailure(folder: string, err: unknown): ToolResult {
  return fail(
    `Could not open the folder "${folder}": ${(err as Error).message}. `
    + `Some entries in a folder list are containers that hold other folders and cannot be opened directly — `
    + `call email_folders and pick a folder that actually holds mail. Nothing was changed.`,
  );
}

function cappedBatch(read: ReturnType<typeof argReader>): number {
  const limit = read.count("limit", DEFAULT_BATCH);
  return Math.min(limit, MAX_BATCH);
}

export const emailDelete: ToolDefinition = {
  name: "email_delete",
  available: imapConfigured,
  effect: { class: "non-idempotent" },
  description:
    "Delete email by MOVING it to the account's Trash folder — the message stays recoverable there until the "
    + "mail provider clears it, and this tool never removes mail permanently. Select what to delete either with "
    + "`uids` (from email_read / email_search / email_read_message) or with the same search filters email_search "
    + "takes (`query`, `from`, `subject`, `body`, `unread_only`, `before`, `since`). At least one selector is "
    + "required — it will not act on a whole mailbox. If the filters match more messages than one call may act on "
    + `(limit, default ${DEFAULT_BATCH}, maximum ${MAX_BATCH}) NOTHING is moved and the true match total is reported, so `
    + "narrow the filters and repeat. Reports how many the server actually confirmed, which can be fewer than "
    + "requested.",
  parameters: {
    type: "object",
    properties: {
      uids: { type: "array", items: { type: "number" }, description: "Exact message UIDs to delete, as returned by email_read / email_search. Cannot be combined with the search filters." },
      query: { type: "string", description: "Free-text: matches subject OR sender" },
      from: { type: "string", description: "Sender address or name contains this" },
      subject: { type: "string", description: "Subject contains this" },
      body: { type: "string", description: "Message body text contains this" },
      unread_only: { type: "boolean", description: "Only unread messages" },
      before: { type: "string", description: "Only messages received before this, as a STRING: ISO date (2025-07-26) or a relative age (\"1 year\", \"30 days\")." },
      since: { type: "string", description: "Only messages received on or after this, as a STRING: ISO date or relative age." },
      folder: { type: "string", description: "Folder to delete from (default: INBOX)" },
      limit: { type: "number", description: `Most messages this call may move (default ${DEFAULT_BATCH}, maximum ${MAX_BATCH})` },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getImapConfig();
    if (typeof cfg === "string") return fail(cfg);
    const read = argReader(args);
    const requestedFolder = read.text("folder") || "INBOX";
    const batch = cappedBatch(read);
    const uids = read.uids("uids");

    const criteria: EmailSearchCriteria = {};
    const from = read.text("from");
    const subject = read.text("subject");
    const body = read.text("body");
    const query = read.text("query");
    const before = read.date("before");
    const since = read.date("since");
    if (from) criteria.from = from;
    if (subject) criteria.subject = subject;
    if (body) criteria.body = body;
    if (before) criteria.before = before;
    if (since) criteria.since = since;
    if (read.flag("unread_only")) criteria.unreadOnly = true;
    if (query) criteria.anyOf = [{ subject: query }, { from: query }];
    if (read.error) return fail(`Refusing to delete: ${read.error}`);

    // Two selectors are two different requests. Honouring one and dropping the
    // other would delete a set the caller never described.
    if (uids.length > 0 && Object.keys(criteria).length > 0) {
      return fail("Give either `uids` or search filters, not both — they select different sets and this tool will not guess which one you meant. Nothing was changed.");
    }
    if (uids.length > MAX_BATCH) {
      return fail(`\`uids\` lists ${uids.length} messages; this tool moves at most ${MAX_BATCH} per call. Split the list. Nothing was changed.`);
    }

    const resolved = await resolve(cfg, requestedFolder);
    if ("content" in resolved) return resolved;
    const { folder, folders } = resolved;

    const trash = folders.find((f) => f.specialUse === TRASH_ROLE);
    if (!trash) {
      return fail(
        "This account does not advertise a Trash folder (RFC 6154 \"\\\\Trash\"), so there is nowhere reversible to "
        + "move the messages to. Refusing to act: deletion here is defined as a move to Trash, and no folder name "
        + "will be guessed at. Nothing was changed.",
      );
    }
    if (trash.path.toLowerCase() === folder.toLowerCase()) {
      return fail(`"${folder}" IS this account's Trash folder. These messages are already deleted; this tool does not remove mail from the server. Nothing was changed.`);
    }

    let targets = uids;
    if (targets.length === 0) {
      try {
        // Whole-mailbox criteria THROW inside searchMessages (C1) before a
        // connection is opened. That error is surfaced, not restated, so the
        // refusal has exactly one definition.
        const page = await searchMessages(cfg, folder, criteria, batch);
        if (page.total === 0) {
          return { content: JSON.stringify({ matched: 0, requested: 0, moved: 0, confirmed: true, destination: trash.path, note: "Nothing matched those filters. No messages were moved." }, null, 2), metadata: { matched: 0, moved: 0 } };
        }
        if (page.truncated) {
          return fail(
            `Those filters match ${page.total} messages, but this call may act on at most ${batch}. NOTHING was moved. `
            + `Deleting the ${page.returned} that fit would silently leave ${page.total - page.returned} behind while reporting success — `
            + `narrow the filters (a tighter date window, a specific sender) or raise \`limit\` up to ${MAX_BATCH}, and repeat.`,
          );
        }
        targets = page.messages.map((m) => m.uid);
      } catch (err) {
        if (/mailbox|folder|select/i.test((err as Error).message)) return openFailure(folder, err);
        return fail(`Refusing to delete: ${(err as Error).message}`);
      }
    }

    try {
      const result = await moveMessages(cfg, folder, targets, trash.path);
      // `moved` is the count the SERVER enumerated when it sends a UIDPLUS map;
      // when `confirmed` is false it is only the count we ASKED for. Reporting
      // the second as if it were the first is how a delete over-reports itself,
      // so the distinction is carried into the payload AND spelled out in prose
      // the model will read.
      const payload: Record<string, unknown> = {
        source: folder,
        destination: result.destination,
        requested: result.requested,
        confirmed: result.confirmed,
        moved: result.confirmed ? result.moved : null,
        uids: targets,
      };
      if (result.requested > 0 && result.moved === 0) {
        return fail(`The server refused the move: 0 of ${result.requested} messages were moved from "${folder}" to "${result.destination}". Nothing was deleted.`);
      }
      payload.note = result.confirmed
        ? `Moved ${result.moved} of ${result.requested} message(s) from "${folder}" to "${result.destination}". They remain recoverable there.`
        : `The server accepted a move of ${result.requested} message(s) from "${folder}" to "${result.destination}" but did NOT report which ones, so the number actually moved is UNKNOWN — do not report it as ${result.requested}. Re-run the same search to see what is left.`;
      return {
        content: JSON.stringify(payload, null, 2),
        metadata: { requested: result.requested, moved: result.confirmed ? result.moved : null, confirmed: result.confirmed, destination: result.destination },
      };
    } catch (err) {
      if (/mailbox|folder|select/i.test((err as Error).message)) return openFailure(folder, err);
      return fail(`Failed to delete from "${folder}": ${(err as Error).message}`);
    }
  },
};

/** The IMAP flags this tool is willing to touch, keyed by the plain-English
 *  argument that controls each. Deliberately closed: an arbitrary-flag
 *  parameter would let a caller set the deleted flag by hand, routing around
 *  everything the file header argues. */
const FLAG_FOR = { read: "\\Seen", starred: "\\Flagged" } as const;

export const emailMark: ToolDefinition = {
  name: "email_mark",
  available: imapConfigured,
  effect: { class: "idempotent-mutation" },
  description:
    "Mark messages in the user's IMAP mailbox as read/unread and starred/unstarred. Takes the `uids` returned by "
    + "email_read, email_search or email_read_message. Set `read` to true to mark read or false to mark unread; set "
    + "`starred` to true or false for the star (\\\\Flagged). Omit either one to leave it untouched. Changes only "
    + "these flags — it never moves, sends or deletes anything.",
  parameters: {
    type: "object",
    properties: {
      uids: { type: "array", items: { type: "number" }, description: "Message UIDs to mark, as returned by email_read / email_search" },
      read: { type: "boolean", description: "true = mark read, false = mark unread. Omit to leave unchanged." },
      starred: { type: "boolean", description: "true = star, false = unstar. Omit to leave unchanged." },
      folder: { type: "string", description: "Folder the uids belong to (default: INBOX)" },
    },
    required: ["uids"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getImapConfig();
    if (typeof cfg === "string") return fail(cfg);
    const read = argReader(args);
    const requestedFolder = read.text("folder") || "INBOX";
    const uids = read.uids("uids");
    const wanted: Record<keyof typeof FLAG_FOR, boolean | undefined> = {
      read: read.triState("read"),
      starred: read.triState("starred"),
    };
    if (read.error) return fail(`Failed to mark messages: ${read.error}`);
    if (uids.length === 0) {
      return fail("email_mark needs `uids` — the message UIDs from email_read or email_search. Nothing was changed.");
    }
    if (uids.length > MAX_BATCH) {
      return fail(`\`uids\` lists ${uids.length} messages; this tool marks at most ${MAX_BATCH} per call. Split the list. Nothing was changed.`);
    }
    const add = Object.entries(wanted).filter(([, v]) => v === true).map(([k]) => FLAG_FOR[k as keyof typeof FLAG_FOR]);
    const remove = Object.entries(wanted).filter(([, v]) => v === false).map(([k]) => FLAG_FOR[k as keyof typeof FLAG_FOR]);
    if (add.length === 0 && remove.length === 0) {
      return fail("email_mark was given nothing to change. Set `read` and/or `starred` to true or false. Nothing was changed.");
    }

    const resolved = await resolve(cfg, requestedFolder);
    if ("content" in resolved) return resolved;
    const { folder } = resolved;

    try {
      const applied: Array<{ action: string; flags: string[]; updated: number }> = [];
      // Two round trips at most, and only for the halves actually asked for —
      // marking a message read must not also clear its star.
      if (add.length > 0) applied.push(await setFlags(cfg, folder, uids, add, "add"));
      if (remove.length > 0) applied.push(await setFlags(cfg, folder, uids, remove, "remove"));
      const refused = applied.filter((a) => a.updated === 0);
      if (refused.length > 0) {
        return fail(`The server refused to change ${refused.map((a) => `${a.action} ${a.flags.join(" ")}`).join(" and ")} on ${uids.length} message(s) in "${folder}". Nothing was changed by those operations.`);
      }
      return {
        content: JSON.stringify({ folder, uids, applied }, null, 2),
        metadata: { folder, count: uids.length, operations: applied.length },
      };
    } catch (err) {
      if (/mailbox|folder|select/i.test((err as Error).message)) return openFailure(folder, err);
      return fail(`Failed to mark messages in "${folder}": ${(err as Error).message}`);
    }
  },
};
