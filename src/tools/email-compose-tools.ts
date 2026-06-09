import { createTransport } from "nodemailer";
import type { ToolDefinition, ToolResult } from "../types.js";
import { vault, writeEmailJson } from "./email-config.js";

export const emailDraft: ToolDefinition = {
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

export const emailSetup: ToolDefinition = {
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
