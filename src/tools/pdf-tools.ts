import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PDFParse } from "pdf-parse";
// @ts-expect-error — no type declarations for pdfkit
import PDFDocument from "pdfkit";
import { PDFDocument as PDFLibDocument } from "pdf-lib";
import type { ToolDefinition, ToolResult } from "../types.js";
import { acquireImages, IMAGES_PARAM_SCHEMA, type ImageSpec } from "./shared/image-acquire.js";
import { verifyWriteLanded } from "./verify.js";
// Resolve caller paths the SAME way SecurityLayer's file-access gate does
// (project-root anchored, no ~ expansion) so the gated path == the opened path.
import { resolveAgentPath as resolvePath } from "../workspace/paths.js";
import { readValidatedFile } from "../security/validated-io.js";
import { resolveOfficeTheme, brandAuthor, brandFooter, type OfficeTheme, THEME_PARAM_SCHEMA } from "./shared/office-theme.js";
import { acquireBrandLogo, logoSize } from "./shared/office-brand.js";
import { parseMarkdown, spansToPlain, type Block, type Span } from "./shared/office-md.js";

// ── Helpers ──

function parsePageNumbers(spec: string, maxPage: number): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [s, e] = trimmed.split("-");
      const start = Math.max(1, parseInt(s, 10));
      const end = Math.min(maxPage, parseInt(e, 10));
      for (let i = start; i <= end; i++) pages.add(i);
    } else {
      const p = parseInt(trimmed, 10);
      if (p >= 1 && p <= maxPage) pages.add(p);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, metadata };
}

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

const hx = (c: string): string => "#" + c.replace(/^#/, "");

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
function renderMarkdown(doc: any, content: string, t: OfficeTheme): void {
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

// ── pdf_read ──

const pdfRead: ToolDefinition = {
  name: "pdf_read",
  description: "Read a PDF file and extract its text content.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the PDF file" },
      pages: { type: "string", description: "Page range, e.g. '1-5', '3', '1,3,5'" },
    },
    required: ["file_path"],
  },
  async execute(args) {
    try {
      const filePath = resolvePath(args.file_path as string);
      // Read the VALIDATED canonical inode (realpath + O_NOFOLLOW leaf) so a
      // symlink swapped in after the gate (R4-19) is rejected, not parsed.
      const buf = readValidatedFile(filePath);
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      const info = await parser.getInfo();
      const meta = {
        pageCount: info.total,
        title: info.info?.Title as string | undefined,
        author: info.info?.Author as string | undefined,
      };

      const partial = args.pages
        ? parsePageNumbers(args.pages as string, info.total)
        : undefined;
      const textResult = await parser.getText(partial ? { partial } : undefined);
      await parser.destroy();

      return ok(textResult.text || "(no text extracted)", meta);
    } catch (e: unknown) {
      return fail(`Failed to read PDF: ${(e as Error).message}`);
    }
  },
};

// ── pdf_create ──

const pdfCreate: ToolDefinition = {
  name: "pdf_create",
  description:
    "Create a PDF file from formatted text. Use \\n for line breaks. " +
    "# for large headings, ## for subheadings, plain text for paragraphs, empty lines for spacing. " +
    'Example: "# Quarterly Report\\n\\n## Revenue\\nTotal revenue grew 15% YoY.\\n\\n## Outlook\\nWe expect continued growth."',
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Output PDF path" },
      content: { type: "string", description: "Formatted text with \\n newlines. Use # for headings, ## for subheadings. Separate paragraphs with \\n\\n." },
      title: { type: "string", description: "PDF title metadata" },
      font_size: { type: "number", description: "Base body font size override (default: theme body size)" },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
    },
    required: ["file_path", "content"],
  },
  async execute(args) {
    try {
      const baseTheme = resolveOfficeTheme(args.theme);
      // Honor an explicit base font size by scaling the theme's doc sizes.
      const theme: OfficeTheme = args.font_size
        ? { ...baseTheme, doc: { ...baseTheme.doc, bodySize: args.font_size as number } }
        : baseTheme;
      const title = (args.title as string) ?? "";
      const acquired = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);
      const logo = await acquireBrandLogo(theme);
      // bufferPages lets us stamp a footer on every page after layout.
      const doc = new PDFDocument({ info: { Title: title, Author: brandAuthor(theme) }, bufferPages: true });
      const chunks: Buffer[] = [];

      const done = new Promise<Buffer>((resolve, reject) => {
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
      });

      // Brand masthead logo (png/jpeg only — pdfkit can't embed gif).
      if (logo && (logo.mimeType === "image/png" || logo.mimeType === "image/jpeg")) {
        const { w, h } = logoSize(logo, 34);
        doc.image(logo.buffer, doc.page.margins.left, doc.y, { width: w, height: h });
        doc.y += h + 8;
      }

      if (title) {
        doc.font("Helvetica-Bold").fontSize(theme.doc.titleSize).fillColor(hx(theme.colors.heading)).text(title);
        const y = doc.y + 2;
        doc.save().rect(doc.x, y, 160, 2).fill(hx(theme.colors.accent)).restore();
        doc.y = y + 10;
      }

      renderMarkdown(doc, args.content as string, theme);

      // Embed each image on its own page; pdfkit only supports png/jpeg natively.
      for (const img of acquired) {
        doc.addPage();
        if (img.mimeType === "image/png" || img.mimeType === "image/jpeg") {
          doc.image(img.buffer, { fit: [500, 600], align: "center", valign: "center" });
        } else {
          // Best-effort marker — gif/webp/svg aren't accepted by pdfkit.image().
          doc.fontSize(theme.doc.bodySize).font("Helvetica-Oblique").fillColor(hx(theme.colors.muted)).text(`[Image: ${img.source}]`);
        }
        if (img.caption) {
          doc.moveDown();
          doc.fontSize(theme.doc.bodySize).font("Helvetica-Oblique").fillColor(hx(theme.colors.muted)).text(img.caption, { align: "center" });
        }
      }

      // Stamp a footer (company + page numbers) on every page.
      const company = brandFooter(theme);
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const label = `${company ? company + "    " : ""}Page ${i - range.start + 1} of ${range.count}`;
        const fy = doc.page.height - 34;
        doc.font("Helvetica").fontSize(8).fillColor(hx(theme.colors.muted))
          .text(label, doc.page.margins.left, fy, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: "center", lineBreak: false });
      }
      doc.end();

      const buf = await done;
      const filePath = resolvePath(args.file_path as string);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, buf);
      const verified = verifyWriteLanded(filePath, { minBytes: 100, mustContain: "%PDF-" });
      if (!verified.ok) return fail(`Failed to create PDF: ${verified.reason}`);
      const imgSuffix = acquired.length ? `, ${acquired.length} image(s)` : "";
      return ok(`PDF created at ${filePath} (${buf.length} bytes${imgSuffix})`);
    } catch (e: unknown) {
      return fail(`Failed to create PDF: ${(e as Error).message}`);
    }
  },
};

// ── pdf_merge ──

const pdfMerge: ToolDefinition = {
  name: "pdf_merge",
  description: "Merge multiple PDF files into a single PDF.",
  parameters: {
    type: "object",
    properties: {
      files: { type: "string", description: "JSON array of input PDF paths" },
      output_path: { type: "string", description: "Output merged PDF path" },
    },
    required: ["files", "output_path"],
  },
  async execute(args) {
    try {
      const paths: string[] = (JSON.parse(args.files as string) as string[]).map(resolvePath);
      if (!Array.isArray(paths) || paths.length === 0) return fail("files must be a non-empty JSON array of paths");

      const merged = await PDFLibDocument.create();
      for (const p of paths) {
        // Read each input from its VALIDATED canonical inode (realpath +
        // O_NOFOLLOW leaf) so a symlink swap after the gate (R4-19) is rejected.
        const buf = readValidatedFile(p);
        const src = await PDFLibDocument.load(buf);
        const copied = await merged.copyPages(src, src.getPageIndices());
        for (const page of copied) merged.addPage(page);
      }

      const outPath = resolvePath(args.output_path as string);
      const outBytes = await merged.save();
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, outBytes);
      return ok(`Merged ${paths.length} PDFs into ${outPath} (${outBytes.length} bytes)`);
    } catch (e: unknown) {
      return fail(`Failed to merge PDFs: ${(e as Error).message}`);
    }
  },
};

// ── pdf_extract_tables ──

const pdfExtractTables: ToolDefinition = {
  name: "pdf_extract_tables",
  description: "Best-effort extraction of table-like structures from a PDF.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the PDF file" },
    },
    required: ["file_path"],
  },
  async execute(args) {
    try {
      const filePath = resolvePath(args.file_path as string);
      // Read the VALIDATED canonical inode (realpath + O_NOFOLLOW leaf) so a
      // symlink swapped in after the gate (R4-19) is rejected, not parsed.
      const buf = readValidatedFile(filePath);
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      const textResult = await parser.getText();
      await parser.destroy();
      const lines = textResult.text.split("\n");

      const tables: string[][] = [];
      let current: string[] = [];

      for (const line of lines) {
        const isTabular =
          line.includes("|") ||
          line.includes("\t") ||
          /\S\s{2,}\S/.test(line);

        if (isTabular && line.trim().length > 0) {
          current.push(line);
        } else {
          if (current.length >= 2) tables.push(current);
          current = [];
        }
      }
      if (current.length >= 2) tables.push(current);

      if (tables.length === 0) return ok("No table-like structures detected.");

      const output = tables
        .map((t, i) => `--- Table ${i + 1} (${t.length} rows) ---\n${t.join("\n")}`)
        .join("\n\n");
      return ok(output, { tableCount: tables.length });
    } catch (e: unknown) {
      return fail(`Failed to extract tables: ${(e as Error).message}`);
    }
  },
};

// ── Exports ──

export const pdfTools: ToolDefinition[] = [pdfRead, pdfCreate, pdfMerge, pdfExtractTables];

export function createPdfTools(): ToolDefinition[] {
  return pdfTools;
}
