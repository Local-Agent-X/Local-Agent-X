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
  fetchHeaders,
  MailboxOpenError,
  moveMessages,
  searchMessages,
  setFlags,
  type EmailHeader,
  type EmailSearchCriteria,
} from "./email-imap.js";
import {
  cappedBatch,
  DEFAULT_BATCH,
  fail,
  MAX_BATCH,
  named,
  openFailure,
  requireExplicitFolder,
  resolveFolder,
  TRASH_ROLE,
  UIDS_FOLDER_PARAM_DESCRIPTION,
} from "./email-mutate-shared.js";

/* `imapConfigured` is the shared export from the config store (C6), imported —
 * not re-inlined — so all six IMAP tools are gated by referentially the same
 * predicate and a copy cannot drift. */

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
    + "narrow the filters and repeat. UIDs are numbered PER FOLDER, so `uids` REQUIRES `folder` set to the folder "
    + "they came from — a uid list on its own is refused rather than assumed to be INBOX. Reports how many the "
    + "server actually confirmed, which can be fewer than requested, and names the sender and subject of every "
    + "message it moved.",
  parameters: {
    type: "object",
    properties: {
      uids: { type: "array", items: { type: "number" }, description: "Exact message UIDs to delete, as returned by email_read / email_search FROM THE SAME FOLDER as `folder`, which becomes required. Cannot be combined with the search filters." },
      query: { type: "string", description: "Free-text: matches subject OR sender" },
      from: { type: "string", description: "Sender address or name contains this" },
      subject: { type: "string", description: "Subject contains this" },
      body: { type: "string", description: "Message body text contains this" },
      unread_only: { type: "boolean", description: "Only unread messages" },
      before: { type: "string", description: "Only messages received before this, as a STRING: ISO date (2025-07-26) or a relative age (\"1 year\", \"30 days\")." },
      since: { type: "string", description: "Only messages received on or after this, as a STRING: ISO date or relative age." },
      folder: { type: "string", description: `${UIDS_FOLDER_PARAM_DESCRIPTION} With search filters instead of \`uids\` it defaults to INBOX.` },
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

    // A uid without a folder is not a message. `folder` defaulting to INBOX
    // meant a model that searched "receipts", got [1000, 1001] and called
    // email_delete({uids}) moved INBOX's 1000 and 1001 — different mail, both
    // folders numbering from 1000 because IMAP assigns uids per mailbox — and
    // got "moved: 2" back. The existence check further down cannot catch that:
    // the uids ARE present, they just mean something else. Nothing downstream
    // can recover the provenance either, so the only place to fix it is here,
    // by refusing to assume.
    //
    // ORDER: before `resolveFolder`, matching email_mark. Whether the CALLER
    // named a folder is answerable from `args` alone, so this refusal costs no
    // LIST and no SELECT — a call we are about to refuse should not first go
    // and inspect the target. It also keeps the refusal LEGIBLE: running it
    // after the Trash lookup meant an account whose Trash could not be resolved
    // failed a folder-less uid delete with the TRASH sentence, so the
    // provenance rule was never reached and a test pinning it went red for an
    // unrelated reason.
    if (uids.length > 0) {
      const needsFolder = requireExplicitFolder(read);
      if (needsFolder) return needsFolder;
    }

    const resolved = await resolveFolder(cfg, requestedFolder);
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
    let subjects: EmailHeader[] = [];
    if (targets.length > 0) {
      // `folder` was proved explicit above, before any round trip.
      //
      // RECORDED RESIDUAL — the existence check and the move are two SELECTs on
      // two connections (fetchHeaders below, then moveMessages at the bottom),
      // so there is a window between them. DECIDED: recorded, not closed.
      //
      // Within one UIDVALIDITY the window is SAFE, and that is not a hope — IMAP
      // forbids uid reuse inside a validity epoch (RFC 3501 §2.3.1.1), so the
      // only thing that can happen to a uid in the gap is that it DISAPPEARS.
      // A disappeared uid is not moved and `moved < requested` reports it, which
      // is the honest outcome the confirmed/unconfirmed split already exists for.
      //
      // The unhandled case is a UIDVALIDITY change landing INSIDE the gap — the
      // mailbox renumbered under us — after which the validated uids name
      // different messages. Neither call reads UIDVALIDITY, so it would not be
      // noticed. Closing it means threading the validity the first SELECT saw
      // into the second and refusing on a mismatch, which changes the signature
      // and return shape of both fetchHeaders() and moveMessages() — a data-layer
      // edit, in the chunk whose job is to GATE the data layer rather than
      // continue it — and adds a fail-CLOSED path (refuse when the server reports
      // no validity, or reports it differently between two connections) to guard
      // an event that requires a mailbox to be deleted and recreated in the
      // milliseconds between two round trips. That trade is worse than the
      // exposure at today's rate, so it is documented rather than done. If it is
      // ever taken: return the validity alongside the headers, pass it as an
      // EXPECTED value to moveMessages, and refuse only when both ends report a
      // validity and they disagree — never when either is unknown.
      //
      // What the check below adds ON TOP of the explicit-folder rule: the uids
      // are resolved IN the folder being moved FROM, so nothing moves unless
      // every requested uid is actually there, and the ones that are not are
      // named. That catches a uid naming a message in the wrong-but-named
      // folder, and the plain case of a uid that no longer exists — which used
      // to come back as a non-error "the number moved is UNKNOWN".
      try {
        subjects = await fetchHeaders(cfg, folder, targets);
      } catch (err) {
        if (err instanceof MailboxOpenError) return openFailure(err);
        return fail(`Refusing to delete: could not verify the messages in "${folder}": ${(err as Error).message}`);
      }
      const present = new Set(subjects.map((h) => h.uid));
      const missing = targets.filter((u) => !present.has(u));
      if (missing.length > 0) {
        return fail(
          `Refusing to delete: ${missing.length} of the ${targets.length} uid(s) given are not in "${folder}" — ${missing.join(", ")}. `
          + `IMAP uids are per-folder, so a uid from one folder names a DIFFERENT message (or none) in another. `
          + `Pass \`folder\` naming the folder the uids came from, or re-run the search there to get its uids. Nothing was moved.`,
        );
      }
    }
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
        // The search ran IN this folder, so its uids are this folder's by
        // construction — no second round trip to prove it.
        subjects = page.messages.map(({ uid, from, subject, date, messageId }) => ({ uid, from, subject, date, messageId }));
      } catch (err) {
        if (err instanceof MailboxOpenError) return openFailure(err);
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
        // Named, not just counted: a payload that says "moved 2" and nothing
        // else cannot be checked against what the caller meant to delete.
        messages: named(subjects),
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
      if (err instanceof MailboxOpenError) return openFailure(err);
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
    + "these flags — it never moves, sends or deletes anything. UIDs are numbered PER FOLDER, so `folder` is "
    + "REQUIRED and must be the folder the uids came from — a uid list on its own is refused rather than "
    + "assumed to be INBOX.",
  parameters: {
    type: "object",
    properties: {
      uids: { type: "array", items: { type: "number" }, description: "Message UIDs to mark, as returned by email_read / email_search FROM THE SAME FOLDER as `folder`" },
      read: { type: "boolean", description: "true = mark read, false = mark unread. Omit to leave unchanged." },
      starred: { type: "boolean", description: "true = star, false = unstar. Omit to leave unchanged." },
      folder: { type: "string", description: UIDS_FOLDER_PARAM_DESCRIPTION },
    },
    required: ["uids", "folder"],
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
    // The SAME rule email_delete enforces, from the same function. `uids` is
    // mandatory here, so this makes `folder` mandatory too — the asymmetry that
    // left email_mark as the one uid-taking mutating verb still guessing a
    // folder. A wrong-target mark is recoverable where a wrong-target delete is
    // not, which is why it did not block C3; it is still a mutation applied to
    // messages the caller never named, reported as success.
    const needsFolder = requireExplicitFolder(read);
    if (needsFolder) return needsFolder;
    const add = Object.entries(wanted).filter(([, v]) => v === true).map(([k]) => FLAG_FOR[k as keyof typeof FLAG_FOR]);
    const remove = Object.entries(wanted).filter(([, v]) => v === false).map(([k]) => FLAG_FOR[k as keyof typeof FLAG_FOR]);
    if (add.length === 0 && remove.length === 0) {
      return fail("email_mark was given nothing to change. Set `read` and/or `starred` to true or false. Nothing was changed.");
    }

    const resolved = await resolveFolder(cfg, requestedFolder);
    if ("content" in resolved) return resolved;
    const { folder } = resolved;

    try {
      type Op = { action: string; flags: string[]; updated: number };
      const applied: Op[] = [];
      const refused: Op[] = [];
      // Two round trips at most, and only for the halves actually asked for —
      // marking a message read must not also clear its star.
      //
      // SHORT-CIRCUITED, deliberately: a refusal here is almost always a
      // mailbox-level condition (read-only SELECT, a server that will not take
      // the keyword), so the second op would refuse too and issuing it can only
      // widen the half-applied window. The two flags are independent, so the
      // ORDER carries no meaning and is not worth choosing between; stopping at
      // the first refusal is the part that removes a reachable partial state.
      // It cannot remove all of them: add-succeeds-then-remove-refuses is still
      // reachable, which is exactly why the reporting below has to be honest.
      for (const [flags, action] of [[add, "add"], [remove, "remove"]] as const) {
        if (flags.length === 0) continue;
        const op = await setFlags(cfg, folder, uids, flags, action);
        if (op.updated === 0) { refused.push(op); break; }
        applied.push(op);
      }
      const describe = (ops: Op[]) => ops.map((a) => `${a.action} ${a.flags.join(" ")}`).join(" and ");
      if (refused.length > 0) {
        // Reporting "nothing was changed" while `\Seen` IS set on the server is
        // the same class of lie as an over-reported delete, pointing the other
        // way: the model tells the user the mark failed and the mailbox has
        // moved underneath them. So the failure states what DID apply first.
        const changed = applied.length > 0
          ? `${describe(applied)} WAS applied to ${uids.length} message(s) in "${folder}" and has NOT been rolled back. `
          : `Nothing was changed. `;
        return fail(
          `${changed}The server then refused to ${describe(refused)} on those message(s). `
          + `The mailbox is now in the state described by "applied" only`
          + `${applied.length > 0 ? ` — re-read the messages before reporting the result` : ""}.`,
        );
      }
      return {
        content: JSON.stringify({ folder, uids, applied }, null, 2),
        metadata: { folder, count: uids.length, operations: applied.length },
      };
    } catch (err) {
      if (err instanceof MailboxOpenError) return openFailure(err);
      return fail(`Failed to mark messages in "${folder}": ${(err as Error).message}`);
    }
  },
};
