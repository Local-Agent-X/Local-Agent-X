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
import {
  closeSweep,
  commitPage,
  movePage,
  openSweep,
  readToken,
  resumeSweep,
  STALE_CURSOR_MESSAGE,
} from "./email-delete-sweep.js";

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
    + "narrow the filters and repeat — OR pass back the `cursor` it hands you, repeatedly, to sweep the whole match "
    + "set a batch at a time without searching again. Do not try to guess a `limit` big enough; use the cursor. "
    + "UIDs are numbered PER FOLDER, so `uids` REQUIRES `folder` set to the folder "
    + "they came from — a uid list on its own is refused rather than assumed to be INBOX. Reports how many the "
    + "server actually confirmed, which can be fewer than requested, and names the sender and subject of every "
    + "message it moved. Messages that are no longer in the folder are counted as `skipped` and are NOT a failure — "
    + "they were already deleted, which is the outcome you asked for.",
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
      cursor: { type: "string", description: "Continue a sweep this tool already started: pass back the opaque cursor it returned, ALONE (no uids, no filters), and repeat until it reports the sweep is finished. Continuing costs no new search and needs no `limit` guess." },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getImapConfig();
    if (typeof cfg === "string") return fail(cfg);
    const read = argReader(args);
    const batch = cappedBatch(read);
    const uids = read.uids("uids");
    const cursor = read.text("cursor");

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

    // A cursor is a THIRD selector, and the same rule applies to it: it names a
    // match set this tool already resolved, so combining it with another
    // selector asks for two different sets. It also carries its own folder —
    // uids are per-mailbox, so a continuation aimed at a different folder is
    // the wrong-target delete C3 closed, wearing a cursor.
    let sweepFolder = "";
    if (cursor) {
      if (uids.length > 0 || Object.keys(criteria).length > 0) {
        return fail("`cursor` continues a match set this tool already resolved — pass it on its own, with no `uids` and no search filters. Nothing was changed.");
      }
      const token = readToken(cursor);
      if (!token) return fail(`That \`cursor\` is not one email_delete issued. ${STALE_CURSOR_MESSAGE}`);
      const askedFolder = read.text("folder");
      if (askedFolder && askedFolder.toLowerCase() !== token.folder.toLowerCase()) {
        return fail(
          `This cursor is a sweep of "${token.folder}", not of "${askedFolder}". IMAP uids are numbered per folder, so applying `
          + `it to another folder would delete DIFFERENT messages that happen to share those numbers. Drop \`folder\` and pass `
          + `the cursor alone, or re-search in "${askedFolder}". Nothing was changed.`,
        );
      }
      sweepFolder = token.folder;
    }
    const requestedFolder = sweepFolder || read.text("folder") || "INBOX";

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
    if (uids.length === 0 && !cursor) {
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

      // WHICH SET, and what a uid missing from it MEANS. The three selectors
      // differ on exactly that second question, so they are decided together
      // rather than left implicit at the point of the move.
      //
      //  · cursor  — uids THIS TOOL resolved, in THIS folder, minutes ago. One
      //    that is gone was almost certainly deleted in the meantime, which is
      //    the outcome the caller asked for: skipped, counted, not failed.
      //  · filters — same provenance, one round trip ago: skipped too.
      //  · uids    — the CALLER's, with no provenance at all. Absence is the
      //    evidence that they came from another folder (C3), and no check
      //    downstream can recover that, so it stays a refusal.
      let targets: number[];
      let onMissing: "refuse" | "skip" = "skip";
      let expectValidity = "";
      if (cursor) {
        const sweep = resumeSweep(cursor);
        // A cursor that is gone must never silently become a fresh sweep: the
        // set it named is unknowable now, and acting on a re-derived one would
        // act on mail the caller never saw.
        if (!sweep) return fail(STALE_CURSOR_MESSAGE);
        targets = sweep.remaining.slice(0, batch);
        expectValidity = sweep.uidValidity;
      } else if (compiled !== null) {
        // `compiled` is non-null exactly on the filter path (built above when
        // and only when there were neither uids nor a cursor), so this is the
        // branch the other two are not — expressed as the thing that decides it.
        let found;
        try {
          found = await session.searchUids(folder, compiled);
        } catch (err) {
          if (err instanceof MailboxOpenError) return openFailure(err);
          return fail(`Refusing to delete: ${(err as Error).message}`);
        }
        if (found.uids.length === 0) {
          return { content: JSON.stringify({ matched: 0, requested: 0, moved: 0, skipped: 0, confirmed: true, destination: trash.path, note: "Nothing matched those filters. No messages were moved." }, null, 2), metadata: { matched: 0, moved: 0 } };
        }
        // THE TRUNCATION GUARD, unchanged in what it refuses: a filter broader
        // than one call may act on moves NOTHING and reports the TRUE total.
        // That guard is what caught a 966-message filter in production and it is
        // still the only protection against a filter far broader than intended.
        //
        // What changes is the way OUT of it. The measured failure was the model
        // guessing a bigger `limit` — 50, 200, 250, 500, never the 1000 ceiling
        // — and paying a full Gmail SEARCH for each wrong guess. The match set
        // is already resolved here, so it is handed back as a cursor instead:
        // the model stops choosing a number and just continues.
        if (found.uids.length > batch) {
          const token = openSweep(folder, found.uidValidity, found.uids);
          return fail(
            `Those filters match ${found.uids.length} messages, but this call may act on at most ${batch}. NOTHING was moved. `
            + `Deleting the ${batch} that fit would silently leave ${found.uids.length - batch} behind while reporting success. `
            + `TO DELETE ALL ${found.uids.length}: call email_delete with cursor="${token}" and NO other arguments, then keep calling it `
            + `with the cursor it returns until it says the sweep is finished — that continues THIS match set without searching again, `
            + `so there is no \`limit\` to guess. To act on FEWER instead: `
            + `narrow the filters (a tighter date window, a specific sender) or raise \`limit\` up to ${MAX_BATCH}, and repeat.`,
          );
        }
        targets = found.uids;
        // Free, and it closes half of the TOCTOU residual this file recorded:
        // the validity the SEARCH saw is checked against the one the resolve
        // sees, so a renumbering between them is refused rather than acted on.
        expectValidity = found.uidValidity;
      } else {
        // `folder` was proved explicit above, before any round trip.
        targets = uids;
        onMissing = "refuse";
      }

      const outcome = await movePage(session, { folder, destination: trash.path, targets, onMissing, expectValidity });
      if (!outcome.ok) {
        // A page that failed leaves the sweep untouched, so the same cursor
        // retries the same page — EXCEPT when the failure means the stored uids
        // can never be right again (a UIDVALIDITY change), where keeping it
        // would only invite the model to retry something that cannot work.
        if (cursor && outcome.fatal) closeSweep(cursor);
        return outcome.result;
      }

      const skipped = outcome.skipped.length;
      const payload: Record<string, unknown> = {
        source: folder,
        destination: trash.path,
        requested: outcome.requested,
        confirmed: outcome.confirmed,
        // `moved` is the count the SERVER enumerated when it sends a UIDPLUS
        // map; null means it did not enumerate. Reporting the requested count as
        // if it were confirmed is how a delete over-reports itself.
        moved: outcome.moved,
        skipped,
        uids: outcome.uids,
        // Named, not just counted: a payload that says "moved 2" and nothing
        // else cannot be checked against what the caller meant to delete.
        messages: named(outcome.headers),
      };
      if (skipped > 0) payload.skipped_uids = outcome.skipped;

      let note: string;
      if (outcome.requested === 0) {
        note = `Nothing was left to move: all ${skipped} message(s) in this batch are no longer in "${folder}", which for a delete means they had already been removed. That is the requested outcome, not a failure.`;
      } else if (outcome.confirmed) {
        note = `Moved ${outcome.moved} of ${outcome.requested} message(s) from "${folder}" to "${trash.path}". They remain recoverable there.`;
      } else {
        note = `The server accepted a move of ${outcome.requested} message(s) from "${folder}" to "${trash.path}" but did NOT report which ones, so the number actually moved is UNKNOWN — do not report it as ${outcome.requested}. Re-run the same search to see what is left.`;
      }
      if (skipped > 0 && outcome.requested > 0) {
        note += ` ${skipped} further message(s) were skipped because they are no longer in "${folder}" — already deleted, not an error.`;
      }

      if (cursor) {
        // The sweep advances by the whole PAGE, skipped messages included: they
        // have been accounted for and re-attempting them would loop forever.
        const more = commitPage(cursor, targets.length, outcome.moved ?? outcome.requested, skipped);
        const sweep = more ? resumeSweep(cursor) : null;
        if (sweep) {
          payload.cursor = cursor;
          payload.remaining = sweep.remaining.length;
          note += ` ${sweep.remaining.length} of this sweep's ${sweep.total} message(s) are still to go — call email_delete with cursor="${cursor}" and nothing else to continue.`;
        } else {
          payload.remaining = 0;
          note += " This sweep is now FINISHED — every message the original search matched has been dealt with. Do not call the cursor again.";
        }
      }

      payload.note = note;
      return {
        content: JSON.stringify(payload, null, 2),
        metadata: { requested: outcome.requested, moved: outcome.moved, skipped, confirmed: outcome.confirmed, destination: trash.path },
      };
    });
  },
};
