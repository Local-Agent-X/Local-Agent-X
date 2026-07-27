import type { ToolDefinition, ToolResult } from "../types.js";
import { getImapConfig, imapConfigured } from "./email-config.js";
import { argReader } from "./email-tool-args.js";
import {
  fetchBody,
  fetchMessages,
  searchMessages,
  type EmailBody,
  type EmailPage,
  type EmailSearchCriteria,
} from "./email-imap.js";

/* `imapConfigured` is imported, not re-declared: it is one rule owned by
 * email-config.ts (where getImapConfig lives) and shared with email_folders.
 * This is the honest half of the send/read split — IMAP is optional (C7a), so a
 * send-only mailbox leaves these three genuinely unusable while email_send
 * still works. */

/**
 * Report the page as it came back, truncation included. `count` keeps its
 * previous meaning (messages actually returned); `total` is what the mailbox
 * matched, which the caller could not see before.
 *
 * `content` is ALWAYS the serialized EmailPage and the metadata key set is
 * always the same three keys — including for an empty page. The empty case
 * used to return a plain sentence with two metadata keys, so a caller doing
 * `JSON.parse(result.content)` (the documented contract) threw on exactly the
 * outcome it was least prepared for, and had to sniff which shape it got.
 * `{"messages": [], "total": 0, ...}` reads perfectly well as "nothing here".
 *
 * When the page IS truncated a `note` is prepended — FIRST key, so it is the
 * first thing in the serialized content rather than a boolean buried past a
 * 10-message array. `truncated: true` is already in the payload; a model that
 * scrolled past it and acted on "the 10 emails from that sender" when there are
 * 4,000 is the failure this sentence exists to prevent, because the verbs
 * downstream of this page are a move and a delete. The key is absent (not
 * `null`) when nothing was cut: there is then nothing to say, and callers that
 * compare the whole page shape keep the exact EmailPage they were promised.
 */
function pageResult(page: EmailPage): ToolResult {
  const payload = page.truncated
    ? {
      note: `Showing the ${page.returned} most recent of ${page.total} matching messages. `
        + "Narrow the search or raise `limit` to see the rest — do not treat this page as the full set.",
      ...page,
    }
    : page;
  return {
    content: JSON.stringify(payload, null, 2),
    metadata: { count: page.returned, total: page.total, truncated: page.truncated },
  };
}

export const emailRead: ToolDefinition = {
  name: "email_read",
  available: imapConfigured,
  description: "Read the most recent emails from the user's configured IMAP mailbox (email_setup). Returns uid, sender, subject, date, and a body snippet for each message; pass a uid to email_read_message for the full text. Use email_search to filter by sender, subject, or date.",
  parameters: {
    type: "object",
    properties: {
      folder: { type: "string", description: "Mailbox folder (default: INBOX)" },
      limit: { type: "number", description: "Maximum messages to return (default: 10)" },
      unread_only: { type: "boolean", description: "Only return unread messages" },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getImapConfig();
    if (typeof cfg === "string") return { content: cfg, isError: true };
    const read = argReader(args);
    const folder = read.text("folder") || "INBOX";
    const limit = read.count("limit", 10);
    const unreadOnly = read.flag("unread_only");
    if (read.error) return { content: `Failed to read emails: ${read.error}`, isError: true };
    try {
      const page = unreadOnly
        ? await searchMessages(cfg, folder, { unreadOnly: true }, limit)
        // null, not "*": in IMAP "*" is the LAST message, so this path used to
        // return exactly one message however large `limit` was.
        : await fetchMessages(cfg, folder, null, limit);
      return pageResult(page);
    } catch (err) {
      return { content: `Failed to read emails: ${(err as Error).message}`, isError: true };
    }
  },
};

export const emailSearch: ToolDefinition = {
  name: "email_search",
  available: imapConfigured,
  description: "Search the user's configured IMAP mailbox. Combine any of: free-text `query` (matches subject or sender), `from`, `subject`, `body`, `unread_only`, and a date window (`before` / `since`). All given filters must match. Example — everything from noreply@example.com older than a year: from=\"noreply@example.com\", before=\"1 year\". Returns uid, sender, subject, date and snippet per message plus the true match total.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text: matches subject OR sender" },
      from: { type: "string", description: "Sender address or name contains this" },
      subject: { type: "string", description: "Subject contains this" },
      body: { type: "string", description: "Message body text contains this" },
      unread_only: { type: "boolean", description: "Only unread messages" },
      before: { type: "string", description: "Only messages received before this, as a STRING: ISO date (2025-07-26) or a relative age (\"1 year\", \"30 days\"). A timestamp number is refused, not ignored." },
      since: { type: "string", description: "Only messages received on or after this, as a STRING: ISO date or relative age. A timestamp number is refused, not ignored." },
      folder: { type: "string", description: "Mailbox folder (default: INBOX)" },
      limit: { type: "number", description: "Maximum results (default: 10)" },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getImapConfig();
    if (typeof cfg === "string") return { content: cfg, isError: true };
    const read = argReader(args);
    const folder = read.text("folder") || "INBOX";
    const limit = read.count("limit", 10);

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
    // The free-text path every existing caller (and the model's habit) uses:
    // subject OR sender, as one server-side OR. It is an `anyOf` rather than a
    // `text` search so it keeps meaning exactly what it meant before, and it
    // ANDs with the explicit predicates instead of replacing them.
    if (query) criteria.anyOf = [{ subject: query }, { from: query }];
    if (read.error) return { content: `Failed to search emails: ${read.error}`, isError: true };

    try {
      // No predicates reaches searchMessages, which refuses whole-mailbox
      // criteria before it opens a connection. Surfacing ITS error rather than
      // pre-empting with a local one keeps a single statement of that rule.
      const page = await searchMessages(cfg, folder, criteria, limit);
      return pageResult(page);
    } catch (err) {
      return { content: `Failed to search emails: ${(err as Error).message}`, isError: true };
    }
  },
};

/**
 * Reading ONE message in full.
 *
 * A separate tool rather than a `uid` parameter on email_read, deliberately. A
 * tool whose result is sometimes a list of snippets and sometimes one full body
 * has no stable shape for the model to plan against: the natural misuse is
 * calling email_read with a uid and a limit and believing the limit did
 * something, or parsing the list shape and finding a body. Two tools make the
 * choice explicit at call time — "which messages" vs "this message" — and make
 * the uid required, which is also the thing that teaches the model that uids
 * are the handle for the later verbs (move, flag, delete).
 *
 * `available` matches the other two: the whole tool is IMAP.
 */
export const emailReadMessage: ToolDefinition = {
  name: "email_read_message",
  available: imapConfigured,
  description: "Read one email in full from the user's configured IMAP mailbox. Takes the `uid` of a message returned by email_read or email_search and returns its readable body text plus attachment metadata (filename, type, size). Attachment contents are not downloaded.",
  parameters: {
    type: "object",
    properties: {
      uid: { type: "number", description: "UID of the message, as returned by email_read or email_search" },
      folder: { type: "string", description: "Mailbox folder the uid belongs to (default: INBOX)" },
    },
    required: ["uid"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getImapConfig();
    if (typeof cfg === "string") return { content: cfg, isError: true };
    const read = argReader(args);
    const uid = read.count("uid", 0);
    // UIDs are per-folder, so a uid without its folder is meaningless — but
    // INBOX is the folder every list defaults to, so defaulting matches where
    // the uid most likely came from.
    const folder = read.text("folder") || "INBOX";
    if (read.error) return { content: `Failed to read message: ${read.error}`, isError: true };
    if (uid <= 0) {
      return {
        content: "email_read_message needs a numeric `uid` from email_read or email_search. "
          + "UIDs identify a message within one folder; list the folder first if you do not have one.",
        isError: true,
      };
    }
    try {
      const message: EmailBody = await fetchBody(cfg, folder, uid);
      const payload = message.truncated
        ? { note: "This body was cut at the size limit — the message continues beyond the text below.", ...message }
        : message;
      return {
        content: JSON.stringify(payload, null, 2),
        metadata: {
          uid: message.uid,
          truncated: message.truncated,
          attachments: message.attachments.length,
        },
      };
    } catch (err) {
      return { content: `Failed to read message: ${(err as Error).message}`, isError: true };
    }
  },
};
