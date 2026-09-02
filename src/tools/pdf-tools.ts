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
import { readValidatedFile } from "../security/layer/index.js";
import { resolveOfficeTheme, brandAuthor, brandFooter, type OfficeTheme, THEME_PARAM_SCHEMA } from "./shared/office-theme.js";
import { acquireBrandLogo, logoSize } from "./shared/office-brand.js";
import { collapseFamily } from "./shared/collapse-family.js";
import { SOURCES_DOC_SENTENCE, SOURCES_PARAM_SCHEMA } from "./shared/provenance-sources.js";
// pdfkit markdown/block renderers — pure layout, split out for the file-size
// gate.
import { hx, renderMarkdown } from "./pdf-render.js";

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
    'Example: "# Quarterly Report\\n\\n## Revenue\\nTotal revenue grew 15% YoY.\\n\\n## Outlook\\nWe expect continued growth." ' +
    SOURCES_DOC_SENTENCE,
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Output PDF path" },
      content: { type: "string", description: "Formatted text with \\n newlines. Use # for headings, ## for subheadings. Separate paragraphs with \\n\\n." },
      title: { type: "string", description: "PDF title metadata" },
      font_size: { type: "number", description: "Base body font size override (default: theme body size)" },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
      sources: SOURCES_PARAM_SCHEMA,
    },
    required: ["file_path", "content"],
  },
  async execute(args) {
    try {
      // `content` is schema-required, but the collapsed `pdf` tool doesn't
      // enforce per-action required args — so a create call can arrive without
      // it. Return an actionable error instead of crashing on undefined.split.
      const content = typeof args.content === "string" ? args.content : "";
      if (!content.trim()) {
        return fail("pdf_create needs non-empty 'content' — the text/markdown body to render (e.g. \"# Title\\n\\nBody…\"). Pass it in the `content` field and retry.");
      }
      const baseTheme = resolveOfficeTheme(args.theme);
      // Honor an explicit base font size by scaling the theme's doc sizes.
      const theme: OfficeTheme = args.font_size
        ? { ...baseTheme, doc: { ...baseTheme.doc, bodySize: args.font_size as number } }
        : baseTheme;
      const title = (args.title as string) ?? "";
      const { images: acquired, notes: imageNotes } = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);
      const logo = await acquireBrandLogo(theme);
      // bufferPages lets us stamp a footer on every page after layout.
      const doc = new PDFDocument({ info: { Title: title, Author: brandAuthor(theme) }, bufferPages: true, lang: "en-US", displayTitle: true });
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

      renderMarkdown(doc, content, theme);

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
      const notes = imageNotes.length ? `\nImage notes:\n${imageNotes.join("\n")}` : "";
      return ok(`PDF created at ${filePath} (${buf.length} bytes${imgSuffix})${notes}`);
    } catch (e: unknown) {
      return fail(`Failed to create PDF: ${(e as Error).message}`);
    }
  },
};

// ── pdf_merge ──

const pdfMerge: ToolDefinition = {
  name: "pdf_merge",
  description: "Merge multiple PDF files into a single PDF. " + SOURCES_DOC_SENTENCE,
  parameters: {
    type: "object",
    properties: {
      files: { type: "string", description: "JSON array of input PDF paths" },
      output_path: { type: "string", description: "Output merged PDF path" },
      sources: SOURCES_PARAM_SCHEMA,
    },
    required: ["files", "output_path"],
  },
  async execute(args) {
    try {
      const paths: string[] = (JSON.parse(args.files as string) as string[]).map(p => resolvePath(p));
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

// One collapsed tool (action param) — the four defs above stay as the
// per-action implementations. pathArgs gating is action-conditional
// (forActions in tool-policies.apps.ts); keep both in sync when adding
// an action.
export const pdfTools: ToolDefinition[] = [
  collapseFamily({
    name: "pdf",
    intro: "Read, create, and merge PDF files, and extract table-like structures from them. For advanced custom layouts beyond these actions, a Node build script may use the bundled pdfkit or pdf-lib directly — `require('pdfkit')` / `require('pdf-lib')` by bare name (never an absolute cwd/node_modules path).",
    actions: {
      read: pdfRead,
      create: pdfCreate,
      merge: pdfMerge,
      extract_tables: pdfExtractTables,
    },
    fullActionDocs: true,
    properties: {
      file_path: { type: "string", description: "(read/create/extract_tables) Path to the PDF file" },
      pages: { type: "string", description: "(read) Page range, e.g. '1-5', '3', '1,3,5'" },
      content: { type: "string", description: "(create) Formatted text with \\n newlines. # for headings, ## for subheadings, \\n\\n between paragraphs." },
      title: { type: "string", description: "(create) PDF title metadata" },
      font_size: { type: "number", description: "(create) Base body font size override" },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
      files: { type: "string", description: "(merge) JSON array of input PDF paths" },
      output_path: { type: "string", description: "(merge) Output merged PDF path" },
      sources: SOURCES_PARAM_SCHEMA,
    },
  }),
];

export function createPdfTools(): ToolDefinition[] {
  return pdfTools;
}
