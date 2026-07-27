/**
 * Pure rendering half of email body retrieval: pick which MIME part to read,
 * turn HTML into something a model can actually read, and cap the result.
 *
 * Deliberately free of any IMAP client so the multipart walk and the HTML
 * rendering are testable without a mailbox, and so email-imap.ts stays the
 * connection owner and nothing else.
 */

/** A MIME node as imapflow reports it in `bodyStructure`. Structural, not
 *  imported from imapflow, so this module has no dependency on the client. */
export interface MimeNode {
  part?: string;
  type: string;
  parameters?: Record<string, string>;
  encoding?: string;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  childNodes?: MimeNode[];
}

export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
}

export interface SelectedPart {
  /** Body part number to hand to IMAP (`BODY[<part>]`). */
  part: string;
  /** True when the chosen part is HTML and needs rendering to text. */
  isHtml: boolean;
}

/**
 * Body character cap. 40k characters is roughly 10k tokens — comfortably above
 * any real email's readable text (a long newsletter renders to ~5-8k chars once
 * markup is stripped) while staying a small enough slice of the model's context
 * that a single `email_body` call cannot crowd out the conversation. Bodies
 * that exceed it are cut, never silently shortened: callers get `truncated`.
 */
export const BODY_CHAR_LIMIT = 40_000;

/** Bytes to pull off the wire before giving up. HTML is markup-heavy, so allow
 *  8x the character cap — enough that a 40k-char text body survives rendering,
 *  bounded enough that a 20MB HTML mail cannot be streamed into memory. */
export const BODY_BYTE_LIMIT = BODY_CHAR_LIMIT * 8;

function isAttachmentNode(node: MimeNode): boolean {
  if ((node.disposition || "").toLowerCase() === "attachment") return true;
  return Boolean(node.dispositionParameters?.filename || node.parameters?.name);
}

/**
 * Choose the part to render as "the body": a text/plain part when the message
 * has one, otherwise text/html. Parts marked as attachments are never chosen —
 * a mail whose only text/plain is an attached .txt should not have that file
 * presented as its body.
 *
 * Returns null when the message has no textual part at all (e.g. a bare
 * image/jpeg), which callers should report rather than rendering markup.
 */
export function selectBodyPart(root: MimeNode | undefined): SelectedPart | null {
  if (!root) return null;
  const candidates: { node: MimeNode; part: string }[] = [];
  const walk = (node: MimeNode): void => {
    if (node.childNodes?.length) {
      node.childNodes.forEach(walk);
      return;
    }
    // imapflow numbers every non-root node. A single-part message's root has no
    // `part`; IMAP still addresses its body as BODY[1], hence the fallback.
    if (!isAttachmentNode(node)) candidates.push({ node, part: node.part || "1" });
  };
  walk(root);
  const plain = candidates.find(c => (c.node.type || "").toLowerCase() === "text/plain");
  if (plain) return { part: plain.part, isHtml: false };
  const html = candidates.find(c => (c.node.type || "").toLowerCase() === "text/html");
  if (html) return { part: html.part, isHtml: true };
  return null;
}

/** Attachment METADATA only — names, types, sizes. Reading attachment bytes is
 *  deliberately out of scope; this exists so a caller can see that a message
 *  has an invoice.pdf without anything downloading it. */
export function collectAttachments(root: MimeNode | undefined): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  const walk = (node: MimeNode): void => {
    if (node.childNodes?.length) {
      node.childNodes.forEach(walk);
      return;
    }
    if (!isAttachmentNode(node)) return;
    out.push({
      filename: node.dispositionParameters?.filename || node.parameters?.name || "(unnamed)",
      mimeType: (node.type || "application/octet-stream").toLowerCase(),
      size: node.size || 0,
    });
  };
  if (root) walk(root);
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", middot: "·", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Render HTML mail as readable plain text. Not a browser: it drops
 * non-rendering elements, turns block boundaries into line breaks, keeps link
 * targets (a marketing mail whose links vanish is unusable for "what did this
 * ask me to do"), and collapses the whitespace HTML authors leave behind.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|section|article)>/gi, "\n\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<li\b[^>]*>/gi, "\n- ");
  text = text.replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const clean = label.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return clean;
    return clean && clean !== href ? `${clean} (${href})` : href;
  });
  text = decodeEntities(text.replace(/<[^>]+>/g, ""));
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Normalise a text/plain part: line endings and trailing whitespace only —
 *  plain text is already what we want, so nothing else is done to it. */
export function normalizePlainText(input: string): string {
  return input.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function capBody(text: string): { text: string; truncated: boolean } {
  if (text.length <= BODY_CHAR_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, BODY_CHAR_LIMIT), truncated: true };
}
