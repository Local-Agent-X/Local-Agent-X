/**
 * `email_delete` — the mailbox-mutating verb that removes mail.
 *
 * Its sibling `email_mark` lives in email-mark-tool.ts (the 400-LOC rule split
 * them); everything the two must agree on — the batch ceiling, the folder rule,
 * the failure wording — lives in email-mutate-shared.ts and is imported by both.
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
  buildSearchQuery,
  MailboxOpenError,
  withSession,
  type EmailHeader,
  type EmailSearchCriteria,
  type SearchObject,
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

    // COMPILED BEFORE ANYTHING DIALS, for the same reason as the rule above.
    // `buildSearchQuery` is what refuses a call with NO selector at all (C1) —
    // `email_delete({})` is a call the schema permits and a model emits, and
    // this throw is the only thing between it and the whole mailbox. It used to
    // fire from inside searchMessages, AFTER the folder list, so a refusal
    // decidable from `args` alone had already paid for one. Decidable here,
    // decided here: it now opens no connection.
    let compiled: SearchObject | null = null;
    if (uids.length === 0) {
      try {
        compiled = buildSearchQuery(criteria);
      } catch (err) {
        // Surfaced, not restated, so the refusal has exactly one definition.
        return fail(`Refusing to delete: ${(err as Error).message}`);
      }
    }

    // ONE CONNECTION for the folder list, the uid check or the search, and the
    // move: three calls into the data layer used to be three connect/TLS/AUTH/
    // logout cycles at 1-3s apiece against Gmail, which is where the 5-47s
    // deletes measured in production came from.
    return withSession(cfg, async (session): Promise<ToolResult> => {
      const resolved = await resolveFolder(session, requestedFolder);
      if ("content" in resolved) return resolved;
      const { folder, folders } = resolved;

      // Both Trash checks are pure computation over the folder list the line
      // above already had to fetch, so they cost no extra round trip and stay
      // ahead of the search: an account with no \Trash cannot delete anything,
      // and saying so only after a search is a MORE expensive refusal.
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
        // RECORDED RESIDUAL — the existence check and the move are two SELECTs
        // (fetchHeaders below, then the move at the bottom), so there is a
        // window between them. One session narrowed it — they are no longer two
        // connections — but it is still a window. DECIDED: recorded, not closed.
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
        // no validity, or reports it differently between two SELECTs) to guard
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
          subjects = await session.fetchHeaders(folder, targets);
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
      // `compiled` is non-null exactly on the filter path (built above when and
      // only when no uids were given), so this is the branch the uid block is
      // not — expressed as the thing that decides it.
      if (compiled !== null) {
        try {
          const page = await session.search(folder, compiled, batch);
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
        const result = await session.moveMessages(folder, targets, trash.path);
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
    });
  },
};
