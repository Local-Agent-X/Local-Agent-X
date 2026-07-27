/**
 * `email_mark` — the read/unread and starred/unstarred verb.
 *
 * Split out of email-mutate-tools.ts under the 400-LOC rule, along the seam the
 * file already had: two independent verbs that agree on a batch ceiling, a
 * folder rule and a failure wording, and share exactly those through
 * email-mutate-shared.ts. Nothing here is a copy of its sibling — the rules it
 * enforces are imported from that module, so the two cannot drift.
 *
 * Deliberately NOT here: any way to set the deleted flag. See the E1 argument
 * in email-mutate-tools.ts's header — a general-purpose flag parameter would
 * route straight around it.
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { getImapConfig, imapConfigured } from "./email-config.js";
import { argReader } from "./email-tool-args.js";
import { MailboxOpenError, withSession } from "./email-imap.js";
import {
  fail,
  MAX_BATCH,
  openFailure,
  requireExplicitFolder,
  resolveFolder,
  UIDS_FOLDER_PARAM_DESCRIPTION,
} from "./email-mutate-shared.js";

/** The IMAP flags this tool is willing to touch, keyed by the plain-English
 *  argument that controls each. Deliberately closed: an arbitrary-flag
 *  parameter would let a caller set the deleted flag by hand, routing around
 *  everything the sibling module's header argues. */
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

    // ONE CONNECTION for the folder list and both flag ops, where this used to
    // be two or three. Same reason as email_delete: the cost is the shape.
    return withSession(cfg, async (session): Promise<ToolResult> => {
      const resolved = await resolveFolder(session, requestedFolder);
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
          const op = await session.setFlags(folder, uids, flags, action);
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
    });
  },
};
