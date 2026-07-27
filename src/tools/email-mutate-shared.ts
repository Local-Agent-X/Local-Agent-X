/**
 * What `email_delete` and `email_mark` agree on: the batch ceiling, how a
 * folder argument becomes a real mailbox, and how a failure is worded.
 *
 * Split out of email-mutate-tools.ts so the two verbs share ONE definition of
 * each. Both tools take `uids` and a `folder`, and the campaign's recurring
 * failure is exactly the kind that appears when two verbs answer the same
 * question slightly differently.
 */
import type { ToolResult } from "../types.js";
import type { argReader } from "./email-tool-args.js";
import {
  type EmailHeader,
  type ImapSession,
  type MailboxFolder,
  type MailboxOpenError,
} from "./email-imap.js";

/**
 * The most messages either verb will act on in ONE call.
 *
 * This is not a page size, it is a blast-radius ceiling — and it is NOT a review
 * gate. The original 200 was argued from "every call is separately gated by the
 * destructive risk class", which only protects anyone if a human looks between
 * batches; this user has said plainly that they do not and will not. What
 * actually protects them is two things that hold identically at any ceiling:
 * the truncation guard, which moves NOTHING and reports the true match total
 * when the filter matches more than the call may act on, and decision E1, which
 * makes a delete a move to Trash and therefore recoverable.
 *
 * So the ceiling is set by RESUMABILITY, not by gating. One IMAP command
 * carrying 10,000 uids is a long-running operation, and a timeout at message
 * 9,000 loses the whole call; at 1,000 a failure costs one batch. That is the
 * only argument left for a number, so it is the number.
 *
 * `DEFAULT_BATCH` is what a call that said nothing about `limit` may move. It is
 * deliberately BELOW the ceiling: 50 was small enough that an ordinary "clear
 * this sender's mail" (656 messages, measured) refused, but making it equal to
 * MAX_BATCH would delete the difference between a caller that chose a blast
 * radius and one that did not think about it at all. 200 clears the ordinary
 * case, and anything larger is one informed retry — the truncation refusal names
 * the true total and the ceiling, and now costs one handshake rather than three.
 */
export const MAX_BATCH = 1000;
export const DEFAULT_BATCH = 200;

/** RFC 6154's role attribute for the trash folder. The ONLY way these tools are
 *  allowed to find it: names are localised ("Bin", "Papierkorb") and namespaced
 *  ("[Gmail]/Trash", "INBOX.Trash"), so any name match is a provider-specific
 *  guess that fails silently on the providers it was not written for. */
export const TRASH_ROLE = "\\Trash";

export interface Resolved {
  folders: MailboxFolder[];
  /** The server's own spelling of the requested source folder. */
  folder: string;
}

export function fail(content: string): ToolResult {
  return { content, isError: true };
}

/** Resolve the folder list and the source folder's real path, ON THE CALLER'S
 *  SESSION — the LIST it needs is also where the \Trash role comes from, so both
 *  verbs get it for one round trip on the connection they will move or flag on.
 *  Returns a ToolResult when it cannot — every failure here is a refusal to
 *  act, never a guess. */
export async function resolveFolder(session: ImapSession, requested: string): Promise<Resolved | ToolResult> {
  let folders: MailboxFolder[];
  try {
    folders = await session.listFolders();
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
  return { folders, folder: match.path };
}

/** Turn a mailbox-open failure into a sentence that names the folder. A
 *  `\Noselect` container (Gmail exposes "[Gmail]" as one) is a real folder in
 *  the LIST output that cannot be SELECTed, and `listFolders` drops `box.flags`
 *  so we cannot see the attribute to pre-empt it.
 *
 *  Only ever reached from a `MailboxOpenError`. It used to be reached from
 *  `/mailbox|folder|select/i` over the message text, which also caught C1's
 *  "refusing to build a query that matches the entire mailbox" — so
 *  `email_delete({})` was told it had picked a container and should retry
 *  against a different folder, when what it had actually done was pass no
 *  filters at all. Every failure that is not that type is now surfaced as
 *  itself. */
export function openFailure(err: MailboxOpenError): ToolResult {
  return fail(
    `${err.message}. `
    + `Some entries in a folder list are containers that hold other folders and cannot be opened directly — `
    + `call email_folders and pick a folder that actually holds mail. Nothing was changed.`,
  );
}

/** The `{uid, from, subject, date}` record the payloads report, so a caller can
 *  see WHICH messages were acted on and not merely how many. */
export function named(headers: EmailHeader[]): Array<Record<string, unknown>> {
  return headers.map((h) => ({ uid: h.uid, from: h.from, subject: h.subject, date: h.date }));
}

/**
 * THE FAMILY-WIDE RULE: a uid list without a folder is not a message set.
 *
 * IMAP numbers uids PER MAILBOX, so [1000, 1001] taken from `receipts` names
 * different mail (or none) in INBOX. Defaulting `folder` to INBOX therefore does
 * not "pick a sensible default" — it silently retargets the caller's request at
 * a set it never saw, and the operation then reports success. No check
 * downstream can catch it: the uids ARE present in INBOX, they just mean
 * something else, and nothing carries the provenance of where they came from.
 *
 * C3 closed this for `email_delete`. `email_mark` kept the default because a
 * wrong-target mark is recoverable, which is true and is also exactly the
 * argument that erodes: the shape is identical, and the next uid-taking verb
 * would copy whichever sibling it was read from. So the rule lives HERE, once,
 * and every uid-taking mutating verb calls it — see the family-wide invariant in
 * test/email-chain-contract.test.ts, which drives the barrel rather than a
 * hand-written list so a NEW verb that forgets this goes red on the commit that
 * adds it.
 *
 * Returns a refusal ToolResult when `folder` was not passed, or null to proceed.
 * `read.text` (not the caller's already-defaulted value) is the input on
 * purpose: the question is whether the CALLER named a folder, which a defaulted
 * string can no longer answer.
 */
export function requireExplicitFolder(read: ReturnType<typeof argReader>): ToolResult | null {
  if (read.text("folder")) return null;
  return fail(
    "`uids` needs `folder`: IMAP uids are numbered per folder, so the same uid names a different message in "
    + "each one and this tool will not assume INBOX. Pass `folder` set to the folder the uids came from "
    + "(the `folder` you passed to email_search / email_read). Nothing was changed.",
  );
}

/** The `folder` parameter description both uid-taking verbs publish. One string,
 *  so the schema the model reads cannot drift from the refusal it gets. */
export const UIDS_FOLDER_PARAM_DESCRIPTION =
  "Folder the uids belong to, and the folder to act on. REQUIRED whenever `uids` is given, because uids are "
  + "numbered per folder and mean different messages in each.";

export function cappedBatch(read: ReturnType<typeof argReader>): number {
  const limit = read.count("limit", DEFAULT_BATCH);
  return Math.min(limit, MAX_BATCH);
}
