import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { PDFParse } from "pdf-parse";
// @ts-expect-error — no type declarations for pdfkit
import PDFDocument from "pdfkit";
import { PDFDocument as PDFLibDocument } from "pdf-lib";
import type { ToolDefinition, ToolResult } from "./types.js";
import { acquireImages, IMAGES_PARAM_SCHEMA, type ImageSpec } from "./tools/shared/image-acquire.js";

// ── Path helper ──

function resolvePath(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

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
      const buf = await readFile(filePath);
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
      font_size: { type: "number", description: "Base font size (default 12)" },
      images: IMAGES_PARAM_SCHEMA,
    },
    required: ["file_path", "content"],
  },
  async execute(args) {
    try {
      const fontSize = (args.font_size as number) ?? 12;
      const acquired = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);
      const doc = new PDFDocument({ info: { Title: (args.title as string) ?? "" } });
      const chunks: Buffer[] = [];

      const done = new Promise<Buffer>((resolve, reject) => {
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
      });

      const lines = (args.content as string).split("\n");
      for (const line of lines) {
        if (line.startsWith("## ")) {
          doc.fontSize(fontSize * 1.3).font("Helvetica-Bold").text(line.slice(3));
          doc.fontSize(fontSize).font("Helvetica");
        } else if (line.startsWith("# ")) {
          doc.fontSize(fontSize * 1.6).font("Helvetica-Bold").text(line.slice(2));
          doc.fontSize(fontSize).font("Helvetica");
        } else if (line.trim() === "") {
          doc.moveDown();
        } else {
          doc.fontSize(fontSize).font("Helvetica").text(line);
        }
      }
      // Embed each image on its own page; pdfkit only supports png/jpeg natively.
      for (const img of acquired) {
        doc.addPage();
        if (img.mimeType === "image/png" || img.mimeType === "image/jpeg") {
          doc.image(img.buffer, { fit: [500, 600], align: "center", valign: "center" });
        } else {
          // Best-effort marker — gif/webp/svg aren't accepted by pdfkit.image().
          doc.fontSize(fontSize).font("Helvetica-Oblique").text(`[Image: ${img.source}]`);
        }
        if (img.caption) {
          doc.moveDown();
          doc.fontSize(fontSize).font("Helvetica-Oblique").text(img.caption, { align: "center" });
        }
      }
      doc.end();

      const buf = await done;
      const filePath = resolvePath(args.file_path as string);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, buf);
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
        const buf = await readFile(p);
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
      const buf = await readFile(filePath);
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
