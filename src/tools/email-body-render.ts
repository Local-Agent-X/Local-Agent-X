/**
 * Pure rendering half of email body retrieval: pick which MIME part to read,
 * turn HTML into something a model can actually read, and cap the result.
 *
 * Deliberately free of any IMAP client so the multipart walk and the HTML
 * rendering are testable without a mailbox, and so email-imap.ts stays the
 * connection owner and nothing else. The one node import here is a stream
 * TYPE: the wire byte cap belongs with the character cap it feeds, not with
 * the socket. HTML becomes text through htmlToText, shared with every other
 * reader of HTML in app-renderer/sanitize.ts.
 */
import type { Readable } from "node:stream";
import { htmlToText } from "../app-renderer/sanitize.js";

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

/**
 * Read a body stream, stopping at `byteLimit` bytes.
 *
 * The cap is enforced HERE, on the stream, not after buffering: the point is
 * that a 20MB message never lands in memory at all. `destroy()` on the way out
 * closes the tap whether the cap fired or the stream ended on its own.
 */
export async function readCapped(stream: Readable, byteLimit: number): Promise<{ buf: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (size + buf.length >= byteLimit) {
      chunks.push(buf.subarray(0, byteLimit - size));
      truncated = true;
      break;
    }
    chunks.push(buf);
    size += buf.length;
  }
  stream.destroy();
  return { buf: Buffer.concat(chunks), truncated };
}

/** `Name <addr>` for display, tolerating an envelope with neither. */
export function formatAddress(addr?: { name?: string; address?: string }): string {
  if (!addr) return "unknown";
  return `${addr.name || ""} <${addr.address || ""}>`.trim();
}

/** A short preview for list views. The raw source after the header break is
 *  markup on HTML mail, so it is rendered before being cut — 200 characters of
 *  `<table style=...>` told the reader nothing. */
export function extractSnippet(raw: string): string {
  const start = raw.indexOf("\r\n\r\n");
  if (start < 0) return "";
  const chunk = raw.slice(start + 4, start + 4000);
  const text = /<[a-zA-Z][^>]*>/.test(chunk) ? htmlToText(chunk) : normalizePlainText(chunk);
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Node understands a handful of charset names; map the ones mail actually
 *  uses onto them and fall back to UTF-8 rather than guessing. Mail that
 *  declares iso-8859-1 and is read as UTF-8 comes back full of U+FFFD. */
export function decodeBuffer(buf: Buffer, charset?: string): string {
  const cs = (charset || "utf-8").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cs === "iso88591" || cs === "latin1" || cs === "windows1252" || cs === "cp1252") return buf.toString("latin1");
  if (cs === "ascii" || cs === "usascii") return buf.toString("ascii");
  if (cs === "utf16le" || cs === "ucs2") return buf.toString("utf16le");
  return buf.toString("utf-8");
}

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

/** Normalise a text/plain part: line endings and trailing whitespace only —
 *  plain text is already what we want, so nothing else is done to it. */
export function normalizePlainText(input: string): string {
  return input.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function capBody(text: string): { text: string; truncated: boolean } {
  if (text.length <= BODY_CHAR_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, BODY_CHAR_LIMIT), truncated: true };
}
