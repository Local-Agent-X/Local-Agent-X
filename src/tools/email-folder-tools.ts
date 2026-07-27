/**
 * `email_folders` — the read-only folder list.
 *
 * `folder` is free text on email_read and email_search, so without this the
 * model guesses: it writes `[Gmail]/Trash` at a provider that calls it `Bin`,
 * or `Sent` at one that calls it `Sent Mail`. This tool answers the question
 * those two parameters ask, and it is the reason deletion can resolve Trash
 * through the RFC 6154 `specialUse` attribute instead of hardcoding a
 * Gmail-specific path.
 *
 * Read-only by construction: it calls exactly one data-layer function, and that
 * function only issues LIST. No create, rename, subscribe, or delete lives here.
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { getImapConfig } from "./email-config.js";
import { listFolders, type MailboxFolder } from "./email-imap.js";

/** Same notion of "configured" the read tools use: getImapConfig() returns a
 *  STRING when IMAP_HOST/USER/PASS aren't all present. Not a second rule. */
const imapConfigured = (): boolean => typeof getImapConfig() !== "string";

/**
 * RFC 6154 roles in the order a caller is likely to want them. Ordering is the
 * whole answer to "dozens of labels is normal" — see the sort below.
 */
const ROLE_ORDER = ["\\Sent", "\\Drafts", "\\Trash", "\\Junk", "\\Archive", "\\Flagged", "\\All"];

/**
 * Rank a folder into a band. Lower sorts first:
 *   0  INBOX — always the answer to "where is my mail"
 *   1  special-use roles, in ROLE_ORDER
 *   2  ordinary subscribed folders
 *   3  unsubscribed folders — real, passable, but not what the user works in
 * Within a band, paths sort alphabetically so the order is stable across calls
 * rather than whatever order the server happened to walk its tree in.
 */
function band(f: MailboxFolder): [number, number, string] {
  if (f.path.toUpperCase() === "INBOX") return [0, 0, f.path];
  if (f.specialUse) {
    const i = ROLE_ORDER.indexOf(f.specialUse);
    return [1, i === -1 ? ROLE_ORDER.length : i, f.path];
  }
  return [f.subscribed ? 2 : 3, 0, f.path];
}

function byUsefulness(a: MailboxFolder, b: MailboxFolder): number {
  const [ab, ar, ap] = band(a);
  const [bb, br, bp] = band(b);
  return ab - bb || ar - br || ap.localeCompare(bp);
}

export const emailFolders: ToolDefinition = {
  name: "email_folders",
  available: imapConfigured,
  readOnly: true,
  effect: { class: "read-only" },
  description:
    "List the folders (mailboxes) in the user's configured IMAP account (email_setup). " +
    "Use this before email_read or email_search when the folder is anything but INBOX: pass a returned " +
    "`path` verbatim as their `folder` argument. Each entry has `path` (what to pass), `name` (the leaf " +
    "label), `specialUse` (the standard role, e.g. \"\\\\Trash\", \"\\\\Sent\", \"\\\\Drafts\", \"\\\\Junk\" — " +
    "null for ordinary folders), and `subscribed`. Identify Trash, Sent, Drafts and Junk by `specialUse`, " +
    "never by name: providers localise and rename them. Read-only; creates and changes nothing.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    const cfg = getImapConfig();
    if (typeof cfg === "string") return { content: cfg, isError: true };
    try {
      const folders = (await listFolders(cfg)).sort(byUsefulness);
      // Deliberately UNCAPPED. A cap here defeats the tool's only purpose —
      // the folder the caller needs is exactly as likely to be the one cut —
      // and the list is bounded by how many folders the account has, not by
      // mailbox size, so even a heavily-labelled account is a few KB, far less
      // than one message body email_read already returns. Ordering, not
      // truncation, is what keeps a long list usable. `total` is therefore
      // always the full count; nothing is dropped silently or otherwise.
      return {
        content: JSON.stringify({ folders, total: folders.length }, null, 2),
        metadata: { count: folders.length, total: folders.length },
      };
    } catch (err) {
      return { content: `Failed to list folders: ${(err as Error).message}`, isError: true };
    }
  },
};
