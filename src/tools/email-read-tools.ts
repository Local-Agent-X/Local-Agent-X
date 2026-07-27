import type { ToolDefinition, ToolResult } from "../types.js";
import { getImapConfig } from "./email-config.js";
import { fetchMessages, searchMessages, type EmailPage } from "./email-imap.js";

/** Both read tools need IMAP and nothing else. getImapConfig() returns a STRING
 *  error when IMAP_HOST/USER/PASS aren't all present — that is the existing
 *  notion of "configured", reused rather than duplicated. This is the honest
 *  half of the send/read split: IMAP is optional (C7a), so a send-only mailbox
 *  leaves these two genuinely unusable while email_send still works. */
const imapConfigured = () => typeof getImapConfig() !== "string";

/** Report the page as it came back, truncation included. `count` keeps its
 *  previous meaning (messages actually returned); `total` is what the mailbox
 *  matched, which the caller could not see before. */
function pageResult(page: EmailPage, emptyMessage: string): ToolResult {
  if (page.returned === 0) return { content: emptyMessage, metadata: { count: 0, total: page.total } };
  return {
    content: JSON.stringify(page, null, 2),
    metadata: { count: page.returned, total: page.total, truncated: page.truncated },
  };
}

export const emailRead: ToolDefinition = {
  name: "email_read",
  available: imapConfigured,
  description: "Read emails from the user's configured IMAP mailbox (email_setup). Returns sender, subject, date, and body snippet for each message.",
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
    const folder = String(args.folder || "INBOX");
    const limit = Number(args.limit) || 10;
    try {
      const page = args.unread_only
        ? await searchMessages(cfg, folder, { unreadOnly: true }, limit)
        // null, not "*": in IMAP "*" is the LAST message, so this path used to
        // return exactly one message however large `limit` was.
        : await fetchMessages(cfg, folder, null, limit);
      return pageResult(page, args.unread_only ? "No unread messages found." : "No messages found.");
    } catch (err) {
      return { content: `Failed to read emails: ${(err as Error).message}`, isError: true };
    }
  },
};

export const emailSearch: ToolDefinition = {
  name: "email_search",
  available: imapConfigured,
  description: "Search the user's configured IMAP mailbox by query (subject and sender fields).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query string" },
      folder: { type: "string", description: "Mailbox folder (default: INBOX)" },
      limit: { type: "number", description: "Maximum results (default: 10)" },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getImapConfig();
    if (typeof cfg === "string") return { content: cfg, isError: true };
    const folder = String(args.folder || "INBOX");
    const limit = Number(args.limit) || 10;
    const query = String(args.query);
    try {
      // Subject OR sender, as before — now one server-side OR in one
      // connection instead of two searches unioned across two connections.
      const page = await searchMessages(cfg, folder, { anyOf: [{ subject: query }, { from: query }] }, limit);
      return pageResult(page, "No messages matched the search query.");
    } catch (err) {
      return { content: `Failed to search emails: ${(err as Error).message}`, isError: true };
    }
  },
};
