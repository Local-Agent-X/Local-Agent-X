import { createTransport } from "nodemailer";
import { ImapFlow } from "imapflow";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, basename } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { getLaxDir } from "../lax-data-dir.js";
import { canonicalizeAttachmentPath } from "./http-egress-guard.js";
import { recentlyDone, markDone, fingerprintOf, describeAge } from "./idempotency.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Send-once window for identical (to, cc, subject, body) payloads. The
// in-process dedup phase already catches MCP-loop within-turn dupes at
// 60s; this is the cross-turn / cross-session backstop because the user
// has confirmed duplicate sends via Fastmail in the wild. Five minutes
// is long enough to catch a model that re-tries after a thought delay
// or a separate-turn nudge, short enough that a deliberate human
// "actually send a second identical follow-up" works after the window.
const EMAIL_SEND_WINDOW_MS = 5 * 60 * 1000;

function resolvePath(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

// Load email config from ~/.lax/email.json (set via Connected APIs UI) or env vars
function loadEmailJson(): Record<string, string> {
  try {
    const p = resolve(getLaxDir(), "email.json");
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch { return {}; }
}

function vault(key: string): string | undefined {
  // Read from the encrypted secrets vault (AES-256-GCM, DPAPI-protected key).
  // Used for the SMTP/IMAP password so it never sits plaintext in email.json.
  // Non-secret config (host/user/from) stays in email.json.
  try {
    const { getSecretsStoreSingleton } = require("../secrets.js") as typeof import("../secrets.js");
    return getSecretsStoreSingleton()?.get(key);
  } catch { return undefined; }
}

/** Resolve which secret name holds the SMTP password.
 *  Lets users reuse an existing secret (e.g. one they saved as `FASTMAIL`)
 *  instead of forcing it to be renamed `SMTP_PASS`. Defaults preserve
 *  backward-compat for setups that already store under SMTP_PASS. */
function resolvePasswordSecretName(kind: "SMTP" | "IMAP"): string {
  const json = loadEmailJson();
  const configured = json[`${kind}_PASS_SECRET`];
  if (configured && configured.trim()) return configured.trim();
  return `${kind}_PASS`;
}

function env(key: string): string | undefined {
  // Password fields resolve vault FIRST so the agent's captured credential
  // wins over any stale env/json value. The lookup name comes from
  // email.json's *_PASS_SECRET pointer (default SMTP_PASS / IMAP_PASS) so
  // the agent can configure email against any existing saved secret.
  if (key === "SMTP_PASS" || key === "IMAP_PASS") {
    const kind = key === "SMTP_PASS" ? "SMTP" : "IMAP";
    const secretName = resolvePasswordSecretName(kind);
    const v = vault(secretName);
    if (v) return v;
    // Backward compat: if the configured name didn't yield a value, also
    // try the literal SMTP_PASS / IMAP_PASS so old setups keep working.
    if (secretName !== key) {
      const legacy = vault(key);
      if (legacy) return legacy;
    }
  }
  return process.env[key] || loadEmailJson()[key] || undefined;
}

/** Write non-secret SMTP config to ~/.lax/email.json. Password is NOT written
 *  here — it must be stored in the secrets vault as SMTP_PASS. */
function writeEmailJson(patch: Record<string, string>): void {
  const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  const dir = resolve(getLaxDir());
  mkdirSync(dir, { recursive: true });
  const p = resolve(dir, "email.json");
  let existing: Record<string, string> = {};
  try { if (existsSync(p)) existing = JSON.parse(readFileSync(p, "utf-8")); } catch {}
  const merged = { ...existing, ...patch };
  // Strip any previously-stored plaintext passwords — they now belong in the vault.
  delete merged.SMTP_PASS;
  delete merged.IMAP_PASS;
  writeFileSync(p, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
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
    const to = String(args.to);
    const subject = String(args.subject);
    const body = String(args.body);
    const cc = args.cc ? String(args.cc) : "";
    const attachmentsRaw = args.attachments ? String(args.attachments) : "";

    // Catastrophic-tier idempotency: a real recipient receiving the same
    // email twice is real damage. Hash payload + recipients; refuse re-send
    // within the window with an explicit "already sent" message so the
    // model knows to surface it rather than retry. Attachments included
    // so attaching the same files counts as the same payload; changing
    // them is a distinct message worth sending.
    const fp = fingerprintOf(to, cc, subject, body, attachmentsRaw);
    const prior = recentlyDone("email_send", fp, EMAIL_SEND_WINDOW_MS);
    if (prior) {
      return {
        content:
          `Email to ${to} with subject "${subject}" was already sent ${describeAge(prior.ageMs)} ` +
          `(prior result: ${prior.result}). Skipped this attempt to prevent a duplicate. ` +
          `If you genuinely need to re-send, wait a few minutes or change the subject/body.`,
        metadata: { skipped: "duplicate", priorResult: prior.result, ageMs: prior.ageMs },
      };
    }

    try {
      const transport = createTransport({ host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass } });
      const mailOpts: Record<string, unknown> = {
        from: cfg.from,
        to,
        subject,
        text: body,
      };
      if (cc) mailOpts.cc = cc;
      if (attachmentsRaw) {
        const paths: string[] = JSON.parse(attachmentsRaw);
        mailOpts.attachments = await Promise.all(
          paths.map(async (p) => {
            // Read the SAME canonicalized inode the egress guard checked
            // (canonicalizeAttachmentPath: tilde-expand → resolve → realpathDeep),
            // so a symlink can't be checked-as-innocent then read-as-secret. The
            // filename keeps the user-facing basename of the supplied path.
            const abs = canonicalizeAttachmentPath(p);
            return { filename: basename(resolvePath(p)), content: await readFile(abs) };
          }),
        );
      }
      const info = await transport.sendMail(mailOpts);
      markDone("email_send", fp, `messageId=${info.messageId}`);
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

const emailSetup: ToolDefinition = {
  name: "email_setup",
  description:
    "Configure SMTP (send) and optionally IMAP (read) for this machine. " +
    "Writes non-secret config (host/port/user/from) to ~/.lax/email.json. " +
    "PASSWORDS are NEVER written here — the password must already live in the encrypted secrets vault. " +
    "Pass `smtp_secret_name` to point at any existing vault entry (e.g. user already saved 'FASTMAIL'); defaults to 'SMTP_PASS'. " +
    "Same for `imap_secret_name` (defaults to 'IMAP_PASS'). " +
    "If the chosen secret is missing, this returns an error explaining how to capture one with browser_capture_to_secret. " +
    "For Fastmail: host=smtp.fastmail.com, port=465 (SSL) or 587 (STARTTLS), user=your Fastmail email, from=same.",
  parameters: {
    type: "object",
    properties: {
      smtp_host: { type: "string", description: "SMTP server host (e.g. smtp.fastmail.com, smtp.gmail.com)." },
      smtp_port: { type: "number", description: "SMTP port. 465 = SSL, 587 = STARTTLS. Default 587." },
      smtp_user: { type: "string", description: "SMTP username — usually your email address." },
      smtp_from: { type: "string", description: "From address on outgoing mail. Usually same as smtp_user." },
      smtp_secret_name: { type: "string", description: "Vault secret name that holds the SMTP password. Default: SMTP_PASS. Use this when the user already has a credential saved under a different name (e.g. FASTMAIL)." },
      imap_host: { type: "string", description: "Optional. IMAP server host for reading mail (e.g. imap.fastmail.com)." },
      imap_port: { type: "number", description: "Optional. IMAP port. Default 993." },
      imap_user: { type: "string", description: "Optional. IMAP username. Defaults to smtp_user if omitted." },
      imap_secret_name: { type: "string", description: "Vault secret name for the IMAP password. Default: IMAP_PASS. Often the same as smtp_secret_name on Fastmail." },
      verify: { type: "boolean", description: "If true (default), attempt a test connection to SMTP before finalizing config. Prevents bad creds from being silently accepted." },
    },
    required: ["smtp_host", "smtp_user", "smtp_from"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const smtpHost = String(args.smtp_host);
    const smtpPort = Number(args.smtp_port) || 587;
    const smtpUser = String(args.smtp_user);
    const smtpFrom = String(args.smtp_from);
    const smtpSecretName = args.smtp_secret_name ? String(args.smtp_secret_name).trim() : "SMTP_PASS";
    const imapHost = args.imap_host ? String(args.imap_host) : undefined;
    const imapPort = Number(args.imap_port) || 993;
    const imapUser = args.imap_user ? String(args.imap_user) : smtpUser;
    const imapSecretName = args.imap_secret_name ? String(args.imap_secret_name).trim() : (imapHost ? "IMAP_PASS" : undefined);
    const verify = args.verify === false ? false : true;

    const smtpPass = vault(smtpSecretName);
    if (!smtpPass) {
      return {
        content:
          `Secret '${smtpSecretName}' is not in the vault. Either pass smtp_secret_name pointing at an existing entry (use list_secrets to see what's saved), or capture a new credential:\n` +
          "1. browser navigate to your provider's app-password page (Fastmail: https://app.fastmail.com/settings/security/integrations).\n" +
          "2. Generate / New app password with scope SMTP (or SMTP+IMAP).\n" +
          `3. When the value appears, call browser_capture_to_secret({name: '${smtpSecretName}', service: 'Fastmail', account: smtpUser, ...}) to store it.\n` +
          "4. Then call email_setup again.",
        isError: true,
      };
    }

    if (verify) {
      try {
        const transport = createTransport({ host: smtpHost, port: smtpPort, secure: smtpPort === 465, auth: { user: smtpUser, pass: smtpPass } });
        await transport.verify();
      } catch (e) {
        return { content: `SMTP verify failed: ${(e as Error).message}. Check host/port/user and that the vault entry '${smtpSecretName}' matches this account.`, isError: true };
      }
    }

    const patch: Record<string, string> = {
      SMTP_HOST: smtpHost, SMTP_PORT: String(smtpPort), SMTP_USER: smtpUser, SMTP_FROM: smtpFrom,
      SMTP_PASS_SECRET: smtpSecretName,
    };
    if (imapHost) {
      patch.IMAP_HOST = imapHost;
      patch.IMAP_PORT = String(imapPort);
      patch.IMAP_USER = imapUser;
      if (imapSecretName) patch.IMAP_PASS_SECRET = imapSecretName;
    }
    try {
      writeEmailJson(patch);
    } catch (e) {
      return { content: `Config write failed: ${(e as Error).message}`, isError: true };
    }

    return {
      content:
        `SMTP configured: ${smtpUser}@${smtpHost}:${smtpPort} (from: ${smtpFrom}, password from vault entry '${smtpSecretName}'). ` +
        (imapHost ? `IMAP: ${imapUser}@${imapHost}:${imapPort} (password from '${imapSecretName}'). ` : "") +
        (verify ? "Verified OK. " : "") +
        "Non-secret config in ~/.lax/email.json. email_send is now ready.",
      metadata: { smtpHost, smtpUser, smtpSecretName, verified: verify },
    };
  },
};

export const emailTools: ToolDefinition[] = [emailSend, emailRead, emailSearch, emailDraft, emailSetup];
export function createEmailTools(): ToolDefinition[] { return emailTools; }
