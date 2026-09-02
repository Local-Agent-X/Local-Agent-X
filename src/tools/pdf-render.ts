/**
 * pdfkit block renderers for the pdf tool's create action (pdf-tools.ts):
 * sanitized markdown — inline spans, headings, lists, quotes, code, tables,
 * rules — laid onto an open pdfkit doc in the house theme. Pure layout over
 * the doc it is handed, no I/O — split out of pdf-tools.ts so the tool module
 * stays under the file-size gate.
 */
import type { OfficeTheme } from "./shared/office-theme.js";
import { parseMarkdown, spansToPlain, type Block, type Span } from "./shared/office-md.js";

export const hx = (c: string): string => "#" + c.replace(/^#/, "");

// pdfkit base-14 mapping for inline styles (Helvetica is the PDF-standard sans,
// closest to the Calibri used elsewhere; Courier for code).
function spanFont(s: Span): string {
  if (s.code) return "Courier";
  if (s.bold && s.italic) return "Helvetica-BoldOblique";
  if (s.bold) return "Helvetica-Bold";
  if (s.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

/** Render one paragraph of inline spans, flowing with pdfkit `continued`. */
function renderSpans(doc: any, spans: Span[], t: OfficeTheme, opts: { size: number; indent?: number; prefix?: string } = { size: 0 }): void {
  const size = opts.size || t.doc.bodySize;
  doc.fontSize(size);
  if (opts.prefix) doc.font("Helvetica").fillColor(hx(t.colors.body)).text(opts.prefix, { continued: true, indent: opts.indent });
  if (!spans.length) { doc.text(""); return; }
  spans.forEach((s, i) => {
    const color = s.href ? t.colors.accent : s.code ? t.colors.subheading : t.colors.body;
    doc.font(spanFont(s)).fillColor(hx(color)).text(s.text, {
      continued: i < spans.length - 1,
      underline: !!s.href,
      indent: i === 0 && !opts.prefix ? opts.indent : undefined,
    });
  });
}

function renderTable(doc: any, t: OfficeTheme, block: Extract<Block, { kind: "table" }>): void {
  const left = doc.page.margins.left;
  const usableW = doc.page.width - left - doc.page.margins.right;
  const ncol = block.header.length || 1;
  const colW = usableW / ncol;
  const rowH = 22;
  const cell = (text: string, x: number, y: number, font: string, color: string) =>
    doc.font(font).fontSize(t.doc.bodySize - 0.5).fillColor(hx(color)).text(text, x + 6, y + 6, { width: colW - 12, height: rowH - 8, ellipsis: true, lineBreak: false });
  const pageBottom = () => doc.page.height - doc.page.margins.bottom;

  let y = doc.y + 4;
  // Header band.
  doc.save().rect(left, y, usableW, rowH).fill(hx(t.colors.accent)).restore();
  block.header.forEach((c, i) => cell(spansToPlain(c), left + i * colW, y, "Helvetica-Bold", t.colors.accentText));
  y += rowH;
  for (let r = 0; r < block.rows.length; r++) {
    if (y + rowH > pageBottom()) { doc.addPage(); y = doc.page.margins.top; }
    if (r % 2 === 1) doc.save().rect(left, y, usableW, rowH).fill(hx(t.colors.band)).restore();
    block.rows[r].forEach((c, i) => cell(spansToPlain(c), left + i * colW, y, "Helvetica", t.colors.body));
    doc.save().moveTo(left, y + rowH).lineTo(left + usableW, y + rowH).lineWidth(0.5).strokeColor(hx(t.colors.border)).stroke().restore();
    y += rowH;
  }
  doc.x = left;
  doc.y = y + 8;
}

/** Render markdown into a pdfkit doc using the house theme. Inline styling,
 *  tables, lists, blockquotes, code, and rules — all from sanitized text. */
export function renderMarkdown(doc: any, content: string, t: OfficeTheme): void {
  const left = doc.page.margins.left;
  let ordinal = 0;
  for (const block of parseMarkdown(content)) {
    if (block.kind === "ordered") ordinal += 1; else ordinal = 0;
    switch (block.kind) {
      case "heading": {
        doc.x = left; doc.moveDown(0.3);
        const size = block.level === 1 ? t.doc.h1Size : block.level === 2 ? t.doc.h2Size : t.doc.h3Size;
        const color = block.level === 3 ? t.colors.accent : block.level === 2 ? t.colors.subheading : t.colors.heading;
        doc.font("Helvetica-Bold").fontSize(size).fillColor(hx(color)).text(spansToPlain(block.spans));
        if (block.level === 1) { const y = doc.y + 1; doc.save().rect(left, y, 120, 1.5).fill(hx(t.colors.accent)).restore(); doc.y = y + 6; }
        break;
      }
      case "para": doc.x = left; renderSpans(doc, block.spans, t, { size: t.doc.bodySize }); break;
      case "bullet": doc.x = left; renderSpans(doc, block.spans, t, { size: t.doc.bodySize, prefix: "•  ", indent: 16 + block.level * 16 }); break;
      case "ordered": doc.x = left; renderSpans(doc, block.spans, t, { size: t.doc.bodySize, prefix: `${ordinal}.  `, indent: 16 + block.level * 16 }); break;
      case "quote": doc.x = left; doc.font("Helvetica-Oblique").fontSize(t.doc.bodySize).fillColor(hx(t.colors.muted)).text(spansToPlain(block.spans), { indent: 16 }); break;
      case "code":
        for (const ln of block.text.split("\n")) doc.font("Courier").fontSize(t.doc.bodySize - 1).fillColor(hx(t.colors.subheading)).text(ln || " ", { indent: 12 });
        break;
      case "table": renderTable(doc, t, block); break;
      case "hr": { const y = doc.y + 2; doc.save().moveTo(left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.5).strokeColor(hx(t.colors.border)).stroke().restore(); doc.y = y + 6; break; }
      case "blank": doc.moveDown(0.5); break;
    }
  }
}
