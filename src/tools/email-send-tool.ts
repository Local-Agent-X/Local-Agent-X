import { createTransport } from "nodemailer";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { canonicalizeAttachmentPath } from "./http-egress-guard.js";
import { recentlyDone, markDone, fingerprintOf, describeAge } from "./idempotency.js";
import { EMAIL_SEND_WINDOW_MS, getSmtpConfig, resolvePath } from "./email-config.js";
import { htmlToText } from "./email-body-render.js";

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
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getSmtpConfig();
    if (typeof cfg === "string") return { content: cfg, isError: true };
    const to = String(args.to);
    const subjectRaw = String(args.subject);
    const body = args.body ? String(args.body) : "";
    const html = args.html ? String(args.html) : "";
    const cc = args.cc ? String(args.cc) : "";
    const bcc = args.bcc ? String(args.bcc) : "";
    const inReplyToRaw = args.in_reply_to ? String(args.in_reply_to) : "";
    const referencesRaw = args.references ? String(args.references) : "";
    const attachmentsRaw = args.attachments ? String(args.attachments) : "";

    if (!body.trim() && !html.trim()) {
      return { content: "Nothing to send: provide `body` (plain text) or `html`.", isError: true };
    }

    // A caller that asked to thread and handed over an unusable id gets told,
    // rather than getting a silently un-threaded send it cannot detect.
    const inReplyTo = inReplyToRaw ? normalizeMessageId(inReplyToRaw) : null;
    if (inReplyToRaw && !inReplyTo) {
      return {
        content:
          `in_reply_to is not a valid Message-ID: ${JSON.stringify(inReplyToRaw)}. ` +
          "Pass the `messageId` field exactly as email_read/email_search returned it, or omit it to send a new thread. " +
          "Nothing was sent.",
        isError: true,
      };
    }

    // `references` is only meaningful as an extension of the parent's chain, so
    // without in_reply_to there is nothing to attach it to. Dropping it silently
    // would leave the caller believing it deepened the threading.
    if (referencesRaw && !inReplyTo) {
      return {
        content:
          "references was supplied without in_reply_to. The References chain is built from the parent " +
          "message, so pass in_reply_to as well (the `messageId` of the message being replied to), or omit " +
          "references. Nothing was sent.",
        isError: true,
      };
    }

    // A reply keeps the parent's subject under a single "Re: ". Clients that
    // group by References would cope without it, but the subject is what the
    // HUMAN reads in the thread list, and a reply titled differently from the
    // thread it belongs to reads as a new conversation.
    const subject = inReplyTo && !REPLY_PREFIX_RE.test(subjectRaw) ? `Re: ${subjectRaw}` : subjectRaw;
    // Never HTML-only: a text/plain alternative is table stakes, and some
    // recipients (plain-text clients, screen readers, digest gateways) see
    // nothing at all without it. `.trim()` and not truthiness: a body of "   "
    // is a blank text/plain part, which is the very thing this guards against.
    const text = body.trim() ? body : htmlToText(html);
    const references = inReplyTo ? buildReferences(referencesRaw, inReplyTo) : [];

    // Catastrophic-tier idempotency: a real recipient receiving the same
    // email twice is real damage. Hash payload + recipients; refuse re-send
    // within the window with an explicit "already sent" message so the
    // model knows to surface it rather than retry. EVERY field that changes
    // what lands in a mailbox is in here â€” bcc adds a recipient, html
    // changes what is rendered, in_reply_to/references change which thread
    // it lands in â€” because a field outside the fingerprint makes a
    // genuinely different email look like a duplicate and get dropped.
    //
    // The COMPOSED values are hashed, never the raw arguments: this tool
    // normalises inputs (adds "Re: ", drops unparseable reference tokens), so
    // two different inputs that compose the identical email must collide. Hash
    // the raw input and the recipient gets the same message twice.
    //
    // Encoded as JSON so the field boundaries survive concatenation
    // (fingerprintOf joins its parts with NO separator, so an unencoded list
    // makes to="a",cc="b" collide with to="ab",cc=""); per-field trim preserves
    // fingerprintOf's "edge whitespace doesn't count" behaviour.
    const fp = fingerprintOf(
      JSON.stringify(
        [to, cc, bcc, subject, text, html, inReplyTo ?? "", references.join(" "), attachmentsRaw].map(s => s.trim()),
      ),
    );
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
            const abs = canonicalizeAttachmentPath(p);
            return { filename: basename(resolvePath(p)), content: await readFile(abs) };
          }),
        );
      }
      const info = await transport.sendMail(mailOpts);
      markDone("email_send", fp, `messageId=${info.messageId}`);
      return {
        content: `Email sent successfully. Message ID: ${info.messageId}`,
        metadata: { messageId: info.messageId, ...(inReplyTo ? { inReplyTo } : {}) },
      };
    } catch (err) {
      return { content: `Failed to send email: ${(err as Error).message}`, isError: true };
    }
  },
};
