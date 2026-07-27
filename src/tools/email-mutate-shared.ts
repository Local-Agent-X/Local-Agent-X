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
  listFolders,
  type EmailHeader,
  type ImapCredentials,
  type MailboxFolder,
  type MailboxOpenError,
} from "./email-imap.js";

/**
 * The most messages either verb will act on in ONE call.
 *
 * This is not a page size, it is a blast-radius ceiling. `searchMessages`
 * returns a PAGE, so the set the tools can enumerate is bounded anyway; the cap
 * makes the bound a stated rule rather than an accident of the default limit.
 * A caller wanting to clear 4,000 messages must narrow the window (by sender,
 * by month) and come back — every call is separately gated by the destructive
 * risk class, which is the point.
 */
export const MAX_BATCH = 200;
export const DEFAULT_BATCH = 50;

/** RFC 6154's role attribute for the trash folder. The ONLY way these tools are
 *  allowed to find it: names are localised ("Bin", "Papierkorb") and namespaced
 *  ("[Gmail]/Trash", "INBOX.Trash"), so any name match is a provider-specific
 *  guess that fails silently on the providers it was not written for. */
export const TRASH_ROLE = "\\Trash";

export interface Resolved {
  cfg: ImapCredentials;
  folders: MailboxFolder[];
  /** The server's own spelling of the requested source folder. */
  folder: string;
}

export function fail(content: string): ToolResult {
  return { content, isError: true };
}

/** Resolve credentials, the folder list, and the source folder's real path.
 *  Returns a ToolResult when it cannot — every failure here is a refusal to
 *  act, never a guess. */
export async function resolveFolder(cfg: ImapCredentials, requested: string): Promise<Resolved | ToolResult> {
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

export function cappedBatch(read: ReturnType<typeof argReader>): number {
  const limit = read.count("limit", DEFAULT_BATCH);
  return Math.min(limit, MAX_BATCH);
}
