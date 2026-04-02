import { createTransport } from "nodemailer";
import { ImapFlow } from "imapflow";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, basename } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

function resolvePath(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

// Load email config from ~/.sax/email.json (set via Connected APIs UI) or env vars
function loadEmailJson(): Record<string, string> {
  try {
    const p = resolve(homedir(), ".sax", "email.json");
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch { return {}; }
}

function env(key: string): string | undefined {
  return process.env[key] || loadEmailJson()[key] || undefined;
}

function getSmtpConfig(): { host: string; port: number; user: string; pass: string; from: string } | string {
  const host = env("SMTP_HOST");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const from = env("SMTP_FROM");
  if (!host || !user || !pass || !from) {
    const missing = [!host && "SMTP_HOST", !user && "SMTP_USER", !pass && "SMTP_PASS", !from && "SMTP_FROM"].filter(Boolean);
    return `Email not configured. Go to Settings → Connected APIs → Email (SMTP/IMAP) to set up, or set env vars: ${missing.join(", ")}`;
  }
  return { host, port: Number(env("SMTP_PORT")) || 587, user, pass, from };
}

function getImapConfig(): { host: string; port: number; user: string; pass: string } | string {
  const host = env("IMAP_HOST");
  const user = env("IMAP_USER");
  const pass = env("IMAP_PASS");
  if (!host || !user || !pass) {
    const missing = [!host && "IMAP_HOST", !user && "IMAP_USER", !pass && "IMAP_PASS"].filter(Boolean);
    return `Email reading not configured. Go to Settings → Connected APIs → Email (SMTP/IMAP) to set up, or set env vars: ${missing.join(", ")}`;
  }
  return { host, port: Number(env("IMAP_PORT")) || 993, user, pass };
}

interface ImapMessage {
  uid: number;
  envelope: {
    from?: { name?: string; address?: string }[];
    subject?: string;
    date?: Date;
  };
  source?: Buffer;
  bodyStructure?: unknown;
}

async function fetchMessages(
  cfg: { host: string; port: number; user: string; pass: string },
  folder: string,
  uids: number[] | string,
  limit: number,
): Promise<{ from: string; subject: string; date: string; snippet: string }[]> {
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      const range = Array.isArray(uids) ? uids.slice(0, limit).join(",") : uids;
      const messages: { from: string; subject: string; date: string; snippet: string }[] = [];
      let count = 0;
      for await (const msg of client.fetch(range || "1:*", { envelope: true, source: true }, { uid: true })) {
        if (count >= limit) break;
        const env = (msg as unknown as ImapMessage).envelope;
        const from = env?.from?.[0] ? `${env.from[0].name || ""} <${env.from[0].address || ""}>`.trim() : "unknown";
        const subject = env?.subject || "(no subject)";
        const date = env?.date ? new Date(env.date).toISOString() : "unknown";
        const raw = (msg as unknown as ImapMessage).source?.toString("utf-8") || "";
        const bodyStart = raw.indexOf("\r\n\r\n");
        const snippet = bodyStart > -1 ? raw.slice(bodyStart + 4, bodyStart + 304).replace(/\r?\n/g, " ").trim() : "";
        messages.push({ from, subject, date, snippet: snippet.slice(0, 200) });
        count++;
      }
      return messages;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

const emailSend: ToolDefinition = {
  name: "email_send",
  description: 'Send an email. Example: to="alice@example.com", subject="Meeting Notes", body="Hi Alice,\\nAttached are the notes.\\nBest, Bob"',
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject line" },
      body: { type: "string", description: "Email body text" },
      cc: { type: "string", description: "CC recipients (comma-separated)" },
      attachments: { type: "string", description: "JSON array of file paths to attach" },
    },
    required: ["to", "subject", "body"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getSmtpConfig();
    if (typeof cfg === "string") return { content: cfg, isError: true };
    try {
      const transport = createTransport({ host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass } });
      const mailOpts: Record<string, unknown> = {
        from: cfg.from,
        to: String(args.to),
        subject: String(args.subject),
        text: String(args.body),
      };
      if (args.cc) mailOpts.cc = String(args.cc);
      if (args.attachments) {
        const paths: string[] = JSON.parse(String(args.attachments));
        mailOpts.attachments = await Promise.all(
          paths.map(async (p) => {
            const abs = resolvePath(p);
            return { filename: basename(abs), content: await readFile(abs) };
          }),
        );
      }
      const info = await transport.sendMail(mailOpts);
      return { content: `Email sent successfully. Message ID: ${info.messageId}`, metadata: { messageId: info.messageId } };
    } catch (err) {
      return { content: `Failed to send email: ${(err as Error).message}`, isError: true };
    }
  },
};

const emailRead: ToolDefinition = {
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

const emailSearch: ToolDefinition = {
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

const emailDraft: ToolDefinition = {
  name: "email_draft",
  description: "Compose an email draft without sending. Returns formatted email for user review before sending.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject line" },
      body: { type: "string", description: "Email body text" },
    },
    required: ["to", "subject", "body"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const to = String(args.to);
    const subject = String(args.subject);
    const body = String(args.body);
    const from = process.env.SMTP_FROM || "(not configured — set SMTP_FROM)";
    const draft = `From: ${from}\nTo: ${to}\nSubject: ${subject}\n\n${body}`;
    return { content: draft, metadata: { status: "draft", to, subject } };
  },
};

export const emailTools: ToolDefinition[] = [emailSend, emailRead, emailSearch, emailDraft];
export function createEmailTools(): ToolDefinition[] { return emailTools; }
