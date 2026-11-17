import { createTransport } from "nodemailer";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { canonicalizeAttachmentPath } from "./http-egress-guard.js";
import { fingerprintOf } from "./idempotency.js";
import { getSmtpConfig } from "./email-config.js";
import { addressesIn, recordSent } from "./email-sent-log.js";
import { repeatSendReason } from "./email-repeat-check.js";
import { resolveAgentPath, sessionIdOf } from "../workspace/paths.js";
import { htmlToText } from "../app-renderer/sanitize.js";
import { EgressPayloadBlocked, assertMailSendAllowed } from "../net/egress-send.js";
import { blocked } from "./result-helpers.js";

/** A reply prefix already on the subject. Only the `Re:` family is matched:
 *  it is the one this tool generates and the one virtually every client
 *  generates, and `Re[2]:`/`RE :` are the same prefix wearing a hat. A subject
 *  that already carries one must not be prefixed again â€” "Re: Re: Notes" is the
 *  visible tell of a broken reply. */
const REPLY_PREFIX_RE = /^\s*re\s*(\[\d+\])?\s*:/i;

/** An RFC 5322 msg-id body: a non-empty left side, exactly one `@`, a non-empty
 *  right side, and none of the characters that would either break the header
 *  (whitespace/CR-LF, angle brackets) or turn one id into a LIST (`,`). */
const MESSAGE_ID_RE = /^[^\s<>,@]+@[^\s<>,@]+$/;

/**
 * Normalise an RFC 5322 msg-id to its `<...>` form, or null if it is not one.
 *
 * Rejecting is load-bearing twice over. A msg-id containing whitespace would be
 * a header-injection vector (CR/LF is whitespace), and a malformed
 * In-Reply-To/References does not thread AT ALL in most clients â€” worse than
 * sending none, because it looks like threading was attempted. Degenerate ids
 * ("@", "a@", "a@b,c@d") are rejected for the same reason: they reach a header
 * that clients then fail to match against the thread.
 */
export function normalizeMessageId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  if (!MESSAGE_ID_RE.test(inner)) return null;
  return `<${inner}>`;
}

/**
 * Build the `References` chain for a reply: the parent's own chain PLUS the
 * parent's Message-ID, in order, deduped.
 *
 * When the caller has only the parent's Message-ID (the common case â€” that is
 * what `fetchMessages`/`searchMessages` return for free, without the parent's
 * own References header), the chain is just that one id. That is a PARTIAL
 * References and it still threads in mail clients; what does not thread is a
 * malformed one, so unparseable ids in the supplied chain are dropped rather
 * than passed through.
 *
 * Long chains are capped: References is a single header line and an unbounded
 * one grows forever. The convention is to keep the thread ROOT (which is what
 * clients group on) plus the most recent ancestors.
 */
export function buildReferences(chainRaw: string, parentId: string | null): string[] {
  const ids: string[] = [];
  for (const token of chainRaw.split(/\s+/)) {
    const id = normalizeMessageId(token);
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (parentId && !ids.includes(parentId)) ids.push(parentId);
  const MAX = 20;
  if (ids.length <= MAX) return ids;
  return [ids[0], ...ids.slice(ids.length - (MAX - 1))];
}

/** An email as it would be sent: the tool normalises its arguments (adds
 *  "Re: ", drops unparseable reference tokens), so this is what is sent,
 *  logged and compared, never the raw arguments. */
export interface ComposedEmail {
  to: string; cc: string; bcc: string; subject: string; text: string; html: string;
  inReplyTo: string | null; references: string[]; attachmentsRaw: string;
}

export function composeEmail(args: Record<string, unknown>): ComposedEmail | { error: string } {
  const str = (v: unknown) => (v ? String(v) : "");
  const to = String(args.to);
  const subjectRaw = String(args.subject);
  const body = str(args.body);
  const html = str(args.html);
  const inReplyToRaw = str(args.in_reply_to);
  const referencesRaw = str(args.references);
  if (!body.trim() && !html.trim()) return { error: "Nothing to send: provide `body` (plain text) or `html`." };

  // A caller that asked to thread and handed over an unusable id gets told,
  // rather than getting a silently un-threaded send it cannot detect.
  const inReplyTo = inReplyToRaw ? normalizeMessageId(inReplyToRaw) : null;
  if (inReplyToRaw && !inReplyTo) {
    return {
      error:
        `in_reply_to is not a valid Message-ID: ${JSON.stringify(inReplyToRaw)}. ` +
        "Pass the `messageId` field exactly as email_read/email_search returned it, or omit it to send a new thread. " +
        "Nothing was sent.",
    };
  }
  // `references` is only meaningful as an extension of the parent's chain, so
  // without in_reply_to there is nothing to attach it to. Dropping it silently
  // would leave the caller believing it deepened the threading.
  if (referencesRaw && !inReplyTo) {
    return {
      error:
        "references was supplied without in_reply_to. The References chain is built from the parent " +
        "message, so pass in_reply_to as well (the `messageId` of the message being replied to), or omit " +
        "references. Nothing was sent.",
    };
  }
  return {
    to, cc: str(args.cc), bcc: str(args.bcc), html, inReplyTo, attachmentsRaw: str(args.attachments),
    // A reply keeps the parent's subject under a single "Re: ". Clients that
    // group by References would cope without it, but the subject is what the
    // HUMAN reads in the thread list, and a reply titled differently from the
    // thread it belongs to reads as a new conversation.
    subject: inReplyTo && !REPLY_PREFIX_RE.test(subjectRaw) ? `Re: ${subjectRaw}` : subjectRaw,
    // Never HTML-only: a text/plain alternative is table stakes, and some
    // recipients (plain-text clients, screen readers, digest gateways) see
    // nothing at all without it. `.trim()` and not truthiness: a body of "   "
    // is a blank text/plain part, which is the very thing this guards against.
    text: body.trim() ? body : htmlToText(html),
    references: inReplyTo ? buildReferences(referencesRaw, inReplyTo) : [],
  };
}

/**
 * The composed email's identity: identical only when the recipient would get
 * the identical email. EVERY field that changes what lands in a mailbox is in
 * it (bcc adds a recipient, html changes what is rendered, in_reply_to and
 * references change which thread it lands in), and it is taken over the
 * COMPOSED values, so two inputs that compose the same email collide.
 *
 * Encoded as JSON so the field boundaries survive concatenation: every field
 * is collapsed into ONE fingerprintOf part, so its "\u0001" join separator
 * never falls between them (to="a",cc="b" must not collide with
 * to="ab",cc=""). Per-field trim keeps "edge whitespace doesn't count".
 */
export function emailFingerprint(c: ComposedEmail): string {
  return fingerprintOf(JSON.stringify(
    [c.to, c.cc, c.bcc, c.subject, c.text, c.html, c.inReplyTo ?? "", c.references.join(" "), c.attachmentsRaw].map((s) => s.trim()),
  ));
}

export const emailSend: ToolDefinition = {
  name: "email_send",
  effect: { class: "non-idempotent" },
  // Unusable without SMTP. getSmtpConfig() is the single existing notion of
  // "configured" â€” it returns the config object, or a STRING error when any of
  // SMTP_HOST/USER/PASS/FROM is missing â€” so this reuses that signal instead of
  // inventing a second one. Only SMTP is consulted: after C7a the IMAP
  // credentials are OPTIONAL, so a send-only user has a genuinely working
  // email_send and it must not be hidden because they never set up reading.
  // email_setup is deliberately NOT gated â€” it is how the user gets here.
  available: () => typeof getSmtpConfig() !== "string",
  description: 'Send an email via the user\'s configured IMAP/SMTP mailbox (set up with email_setup). ' +
    'Example: to="alice@example.com", subject="Meeting Notes", body="Hi Alice,\\nAttached are the notes.\\nBest, Bob"',
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject line" },
      body: { type: "string", description: "Email body as plain text. Optional only if `html` is given." },
      html: { type: "string", description: "Optional HTML body. Sent alongside the plain text as a multipart alternative; if `body` is omitted, a plain-text version is derived from this." },
      cc: { type: "string", description: "CC recipients (comma-separated)" },
      bcc: { type: "string", description: "BCC recipients (comma-separated). Delivered, but not shown in the headers the other recipients see." },
      in_reply_to: { type: "string", description: "Message-ID of the email being replied to â€” the `messageId` field returned by email_read/email_search. Threads the reply into the existing conversation instead of starting a new one, and prefixes the subject with 'Re: '." },
      references: { type: "string", description: "Optional. The parent message's own References header (space-separated Message-IDs), if known. Improves threading depth; the parent's Message-ID is appended automatically." },
      attachments: { type: "string", description: "JSON array of file paths to attach" },
    },
    required: ["to", "subject"],
  },
  // The same message again to someone who has not answered asks the user
  // first (email-repeat-check.ts): code finds the candidate, a model judges it.
  confirmWithUser: (args) => {
    const composed = composeEmail(args);
    return "error" in composed ? null : repeatSendReason(composed, emailFingerprint(composed));
  },
  describeCall: (args) => `Email ${String(args.to ?? "")}: "${String(args.subject ?? "")}"`,
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getSmtpConfig();
    if (typeof cfg === "string") return { content: cfg, isError: true };
    const composed = composeEmail(args);
    if ("error" in composed) return { content: composed.error, isError: true };
    const { to, cc, bcc, subject, text, html, inReplyTo, references, attachmentsRaw } = composed;

    try {
      const transport = createTransport({ host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass } });
      const mailOpts: Record<string, unknown> = {
        from: cfg.from,
        to,
        subject,
        text,
      };
      if (html) mailOpts.html = html;
      if (cc) mailOpts.cc = cc;
      // Nodemailer keeps bcc off the transmitted headers and puts it on the
      // SMTP envelope, so the other recipients never learn about it.
      if (bcc) mailOpts.bcc = bcc;
      if (inReplyTo) {
        // Nodemailer emits these as real headers; hand-rolling MIME here
        // would be a second, worse mail composer.
        mailOpts.inReplyTo = inReplyTo;
        if (references.length) mailOpts.references = references;
      }
      if (attachmentsRaw) {
        const paths: string[] = JSON.parse(attachmentsRaw);
        mailOpts.attachments = await Promise.all(
          paths.map(async (p) => {
            // Read the SAME canonicalized inode the egress guard checked
            // (canonicalizeAttachmentPath: tilde-expand â†’ resolve â†’ realpathDeep),
            // so a symlink can't be checked-as-innocent then read-as-secret. The
            // filename keeps the user-facing basename of the supplied path.
            const abs = canonicalizeAttachmentPath(p, sessionIdOf(args));
            return { filename: basename(resolveAgentPath(p, sessionIdOf(args))), content: await readFile(abs) };
          }),
        );
      }
      // What leaves is judged as composed, attachments' bytes included: the
      // dispatch gate saw the arguments, not the files this tool reads.
      const files = (mailOpts.attachments as Array<{ content: Buffer }> | undefined) ?? [];
      assertMailSendAllowed([to, cc, bcc].filter(Boolean).join(", "), [to, cc, bcc, subject, text, html, ...files.map((f) => f.content)]);
      const info = await transport.sendMail(mailOpts);
      try {
        recordSent({
          at: Date.now(), recipients: addressesIn([to, cc, bcc].join(", ")), subject, text,
          messageId: info.messageId, inReplyTo, fingerprint: emailFingerprint(composed),
        });
      } catch { /* the mail went out; a lost record only costs the next repeat check */ }
      // Who and what, so the reply (spoken, in a voice chat) can say it.
      return {
        content: `Email sent to ${[to, cc].filter(Boolean).join(", ")}: "${subject}". Message ID: ${info.messageId}`,
        metadata: { messageId: info.messageId, ...(inReplyTo ? { inReplyTo } : {}) },
      };
    } catch (err) {
      if (err instanceof EgressPayloadBlocked) {
        return blocked(err.message, {
          layer: err.layer,
          recovery: err.clearable ? "Leave the sensitive content out of the email, or ask the user to click \"Declassify & retry\" on this card." : "Remove that content from the email and retry.",
          ...(err.clearable ? { clearable: err.clearable } : {}),
        });
      }
      return { content: `Failed to send email: ${(err as Error).message}`, isError: true };
    }
  },
};
