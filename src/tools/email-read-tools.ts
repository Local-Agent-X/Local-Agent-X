import { ImapFlow } from "imapflow";
import type { ToolDefinition, ToolResult } from "../types.js";
import { getImapConfig } from "./email-config.js";
import { fetchMessages } from "./email-imap.js";

export const emailRead: ToolDefinition = {
  name: "email_read",
  description: "Read emails from a mailbox folder. Returns sender, subject, date, and body snippet for each message.",
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
      if (args.unread_only) {
        const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
        try {
          await client.connect();
          const lock = await client.getMailboxLock(folder);
          try {
            const raw = await client.search({ seen: false }, { uid: true });
            const uids = Array.isArray(raw) ? raw : [];
            if (!uids.length) return { content: "No unread messages found.", metadata: { count: 0 } };
            await client.logout();
            const msgs = await fetchMessages(cfg, folder, uids.slice(-limit), limit);
            return { content: JSON.stringify(msgs, null, 2), metadata: { count: msgs.length } };
          } finally {
            lock.release();
          }
        } catch (inner) {
          await client.logout().catch(() => {});
          throw inner;
        }
      }
      const msgs = await fetchMessages(cfg, folder, "*", limit);
      return { content: JSON.stringify(msgs, null, 2), metadata: { count: msgs.length } };
    } catch (err) {
      return { content: `Failed to read emails: ${(err as Error).message}`, isError: true };
    }
  },
};

export const emailSearch: ToolDefinition = {
  name: "email_search",
  description: "Search emails by query. Searches subject and sender fields.",
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
      const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
      let uids: number[] = [];
      try {
        await client.connect();
        const lock = await client.getMailboxLock(folder);
        try {
          const rawSubject = await client.search({ subject: query }, { uid: true });
          const rawFrom = await client.search({ from: query }, { uid: true });
          const subjectUids = Array.isArray(rawSubject) ? rawSubject : [];
          const fromUids = Array.isArray(rawFrom) ? rawFrom : [];
          const combined = new Set([...subjectUids, ...fromUids]);
          uids = Array.from(combined);
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
      if (!uids.length) return { content: "No messages matched the search query.", metadata: { count: 0 } };
      const msgs = await fetchMessages(cfg, folder, uids.slice(-limit), limit);
      return { content: JSON.stringify(msgs, null, 2), metadata: { count: msgs.length } };
    } catch (err) {
      return { content: `Failed to search emails: ${(err as Error).message}`, isError: true };
    }
  },
};
