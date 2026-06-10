/**
 * Markdown → neutral block AST + text sanitizer, shared by the Word and PDF
 * renderers so both understand the same syntax and emit the same CLEAN text.
 *
 * No-leak guarantee: generated documents must never contain model-output tells
 * — HTML tags (<div>, <p>, <br>, <span …>), HTML entities (&nbsp; &amp;),
 * HTML comments, or zero-width characters. `cleanText` strips all of those.
 * Markdown SYNTAX (**, _, `, [..](..), |, #) is consumed by the parser, not
 * printed. Code blocks/spans are preserved verbatim (literal code is content,
 * not a leak).
 */
import { decodeHtmlEntities } from "../../app-renderer/sanitize.js";

// Only RECOGNIZED HTML tags are stripped — a letter must follow '<', so prose
// like "a < b" or "x <= y" is preserved. Matches <div>, </p>, <br/>,
// <span style="...">, etc.
const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*?)?\/?>/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Strip HTML tags/comments/entities + zero-width chars from a text fragment.
 *  Entities are decoded first so an ESCAPED tag (&lt;div&gt;) becomes a real
 *  tag and is then stripped; the tag pass loops to a fixpoint so split/nested
 *  tags can't survive. */
export function cleanText(s: unknown): string {
  if (typeof s !== "string") return s == null ? "" : String(s);
  let out = decodeHtmlEntities(s).replace(HTML_COMMENT_RE, "");
  let prev: string;
  do { prev = out; out = out.replace(HTML_TAG_RE, ""); } while (out !== prev);
  return out.replace(ZERO_WIDTH_RE, "");
}

export interface Span { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; href?: string }

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; spans: Span[] }
  | { kind: "para"; spans: Span[] }
  | { kind: "bullet"; level: number; spans: Span[] }
  | { kind: "ordered"; level: number; spans: Span[] }
  | { kind: "quote"; spans: Span[] }
  | { kind: "code"; text: string }
  | { kind: "table"; header: Span[][]; rows: Span[][][] }
  | { kind: "hr" }
  | { kind: "blank" };

// Inline constructs, in precedence order: code span, bold, italic, strike, link.
const INLINE_RE =
  /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*(?!\s)([^*\n]+?)\*|(?<![A-Za-z0-9])_(?!\s)([^_\n]+?)_|\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;

/** Parse inline markdown into styled spans. Plain text + every span's text is
 *  run through cleanText so no markup leaks. Code spans keep their literal text. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  const push = (t: string, opts: Partial<Span> = {}, raw = false) => {
    const v = raw ? t : cleanText(t);
    if (v) spans.push({ text: v, ...opts });
  };
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index));
    if (m[2] !== undefined) push(m[2], { code: true }, true);
    else if (m[3] !== undefined) push(m[3], { bold: true });
    else if (m[4] !== undefined) push(m[4], { bold: true });
    else if (m[5] !== undefined) push(m[5], { strike: true });
    else if (m[6] !== undefined) push(m[6], { italic: true });
    else if (m[7] !== undefined) push(m[7], { italic: true });
    else if (m[8] !== undefined) push(m[8], { href: cleanText(m[9]) });
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) push(text.slice(last));
  return spans.length ? spans : [{ text: "" }];
}

const splitRow = (line: string): string[] =>
  line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
const isTableSep = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const indentLevel = (raw: string): number => Math.floor((raw.match(/^\s*/)?.[0].replace(/\t/g, "  ").length ?? 0) / 2);

/** Parse a markdown document into a neutral block list. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // Fenced code block.
    const fence = trimmed.match(/^(```|~~~)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) { body.push(lines[i]); i++; }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    // Table: a pipe row immediately followed by a separator row.
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(trimmed).map(parseInline);
      const rows: Span[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i].trim()).map(parseInline));
        i++;
      }
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (trimmed === "") { blocks.push({ kind: "blank" }); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { blocks.push({ kind: "hr" }); continue; }

    let mm: RegExpMatchArray | null;
    if ((mm = trimmed.match(/^(#{1,3})\s+(.*)$/))) {
      blocks.push({ kind: "heading", level: mm[1].length as 1 | 2 | 3, spans: parseInline(mm[2]) });
    } else if ((mm = line.match(/^\s*>\s?(.*)$/))) {
      blocks.push({ kind: "quote", spans: parseInline(mm[1]) });
    } else if ((mm = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      blocks.push({ kind: "ordered", level: indentLevel(raw), spans: parseInline(mm[1]) });
    } else if ((mm = line.match(/^\s*[-*+]\s+(.*)$/))) {
      blocks.push({ kind: "bullet", level: indentLevel(raw), spans: parseInline(mm[1]) });
    } else {
      blocks.push({ kind: "para", spans: parseInline(trimmed) });
    }
  }
  return blocks;
}

/** Flatten spans back to clean plain text (for sinks without inline styling:
 *  PPT text, Excel cells, captions). */
export function spansToPlain(spans: Span[]): string {
  return spans.map((s) => s.text).join("");
}

/** One-shot: sanitize a possibly-markdown string down to clean plain text,
 *  dropping block syntax markers (#, -, >) too. */
export function toPlainText(s: string): string {
  return cleanText(s)
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|`([^`]+)`/g, (_x, a, b, c, d) => a ?? b ?? c ?? d ?? "")
    .replace(/\*([^*\n]+?)\*|_([^_\n]+?)_/g, (_x, a, b) => a ?? b ?? "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}
