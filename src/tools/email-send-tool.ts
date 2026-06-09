import { createTransport } from "nodemailer";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { canonicalizeAttachmentPath } from "./http-egress-guard.js";
import { recentlyDone, markDone, fingerprintOf, describeAge } from "./idempotency.js";
import { EMAIL_SEND_WINDOW_MS, getSmtpConfig, resolvePath } from "./email-config.js";

export const emailSend: ToolDefinition = {
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
