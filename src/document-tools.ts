import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as docx from "docx";
import mammoth from "mammoth";
import type { ToolDefinition, ToolResult } from "./types.js";
import { acquireImages, IMAGES_PARAM_SCHEMA, type AcquiredImage, type ImageSpec } from "./tools/shared/image-acquire.js";

/** Resolve ~ and relative paths to absolute Windows paths */
function resolvePath(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun } = docx;

/**
 * Scale an image to fit a default-ish max width (~600 px) while
 * preserving aspect ratio. docx wants pixel dimensions; SVG has no
 * intrinsic pixel size so we fall back to 600x400.
 */
function imageRunFor(img: AcquiredImage): docx.ImageRun {
  const MAX_W = 600;
  let w = img.width || MAX_W;
  let h = img.height || Math.round(MAX_W * 0.66);
  if (w > MAX_W) { h = Math.round((h * MAX_W) / w); w = MAX_W; }
  const type: "png" | "jpg" | "gif" | "bmp" =
    img.mimeType === "image/jpeg" ? "jpg" :
    img.mimeType === "image/gif" ? "gif" :
    "png";
  return new ImageRun({
    type,
    data: img.buffer,
    transformation: { width: w, height: h },
  } as docx.IImageOptions);
}

function imageParagraphs(images: AcquiredImage[]): docx.Paragraph[] {
  const paras: docx.Paragraph[] = [];
  for (const img of images) {
    if (img.mimeType === "image/svg+xml" || img.mimeType === "image/webp") {
      // docx ImageRun does not accept svg/webp directly — fall back to a
      // bracketed text marker rather than corrupting the .docx. We still
      // surface that the image was acquired.
      paras.push(new Paragraph({ children: [new TextRun({ text: `[Image: ${img.source}]`, italics: true })] }));
    } else {
      paras.push(new Paragraph({ children: [imageRunFor(img)] }));
    }
    if (img.caption) {
      paras.push(new Paragraph({ children: [new TextRun({ text: img.caption, italics: true })] }));
    }
  }
  return paras;
}

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, metadata };
}
function err(content: string): ToolResult {
  return { content, isError: true };
}

// ── Markdown-ish parser ──

function parseLine(line: string): docx.Paragraph {
  // Headings
  const h3 = line.match(/^###\s+(.*)/);
  if (h3) return new Paragraph({ heading: HeadingLevel.HEADING_3, children: parseInline(h3[1]) });
  const h2 = line.match(/^##\s+(.*)/);
  if (h2) return new Paragraph({ heading: HeadingLevel.HEADING_2, children: parseInline(h2[1]) });
  const h1 = line.match(/^#\s+(.*)/);
  if (h1) return new Paragraph({ heading: HeadingLevel.HEADING_1, children: parseInline(h1[1]) });

  // Bullet list
  const bullet = line.match(/^[-*]\s+(.*)/);
  if (bullet) {
    return new Paragraph({
      bullet: { level: 0 },
      children: parseInline(bullet[1]),
    });
  }

  // Empty line → empty paragraph (spacing)
  if (line.trim() === "") {
    return new Paragraph({ children: [] });
  }

  // Normal paragraph
  return new Paragraph({ children: parseInline(line) });
}

function parseInline(text: string): docx.TextRun[] {
  const runs: docx.TextRun[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      runs.push(new TextRun(text.slice(last, match.index)));
    }
    runs.push(new TextRun({ text: match[1], bold: true }));
    last = re.lastIndex;
  }
  if (last < text.length) {
    runs.push(new TextRun(text.slice(last)));
  }
  return runs;
}

function buildDocument(text: string, title?: string, images: AcquiredImage[] = []): docx.Document {
  const lines = text.split("\n");
  const paragraphs = lines.map(parseLine);
  const children = [...paragraphs, ...imageParagraphs(images)];

  return new Document({
    creator: "Secret Agent X",
    title: title ?? "Document",
    sections: [{ properties: {}, children }],
  });
}

// ── Tools ──

const documentCreate: ToolDefinition = {
  name: "document_create",
  description:
    "Create a Word .docx document from formatted text. " +
    "IMPORTANT: Use markdown formatting with \\n newlines between elements. " +
    "# Heading 1, ## Heading 2, ### Heading 3 for headings. " +
    "Lines starting with - or * become bullet points. **word** for bold. " +
    'Example: "# Report Title\\n\\n## Summary\\nRevenue grew 15%.\\n\\n## Action Items\\n- Hire 2 engineers\\n- Launch beta\\n- **Review** Q2 targets"',
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Output .docx file path" },
      title: { type: "string", description: "Document title metadata (optional)" },
      content: { type: "string", description: "Formatted text with \\n newlines. Use # for headings, - for bullets, **bold** for emphasis. Separate sections with blank lines (\\n\\n)." },
      images: IMAGES_PARAM_SCHEMA,
    },
    required: ["file_path", "content"],
  },
  async execute(args) {
    try {
      const filePath = resolvePath(String(args.file_path));
      const content = String(args.content);
      const title = args.title ? String(args.title) : undefined;
      const acquired = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);

      await mkdir(dirname(filePath), { recursive: true });
      const doc = buildDocument(content, title, acquired);
      const buffer = await Packer.toBuffer(doc);
      await writeFile(filePath, buffer);

      const lineCount = content.split("\n").filter((l) => l.trim()).length;
      const imgSuffix = acquired.length ? `, ${acquired.length} image(s)` : "";
      return ok(`Created ${filePath} (${lineCount} content lines${imgSuffix}, ${buffer.length} bytes)`);
    } catch (e: unknown) {
      return err(`Failed to create document: ${(e as Error).message}`);
    }
  },
};

const documentRead: ToolDefinition = {
  name: "document_read",
  description: "Read a Word .docx file and extract its text content.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to .docx file to read" },
    },
    required: ["file_path"],
  },
  async execute(args) {
    try {
      const filePath = resolvePath(String(args.file_path));
      const result = await mammoth.extractRawText({ path: filePath });
      const text = result.value.trim();
      if (!text) return ok("(document is empty)");
      return ok(text, { characters: text.length, words: text.split(/\s+/).length });
    } catch (e: unknown) {
      return err(`Failed to read document: ${(e as Error).message}`);
    }
  },
};

const documentEdit: ToolDefinition = {
  name: "document_edit",
  description:
    "Find and replace text in a Word .docx file. Reads the document, performs replacements, and recreates it.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to .docx file to edit" },
      find: { type: "string", description: "Text to find" },
      replace: { type: "string", description: "Replacement text" },
    },
    required: ["file_path", "find", "replace"],
  },
  async execute(args) {
    try {
      const filePath = resolvePath(String(args.file_path));
      const find = String(args.find);
      const replace = String(args.replace);

      const result = await mammoth.extractRawText({ path: filePath });
      const original = result.value;

      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "g");
      const matches = original.match(re);
      const count = matches ? matches.length : 0;

      if (count === 0) return ok(`No occurrences of "${find}" found in ${filePath}.`);

      const updated = original.replace(re, replace);
      const doc = buildDocument(updated);
      const buffer = await Packer.toBuffer(doc);
      await writeFile(filePath, buffer);

      return ok(`Replaced ${count} occurrence(s) of "${find}" with "${replace}" in ${filePath}.`);
    } catch (e: unknown) {
      return err(`Failed to edit document: ${(e as Error).message}`);
    }
  },
};

const documentTemplate: ToolDefinition = {
  name: "document_template",
  description:
    "Fill a Word .docx template by replacing {{placeholders}} with values. " +
    "The template file must contain {{key}} markers. Pass variables as a JSON object string. " +
    'Example: template has "Dear {{name}}, your invoice {{invoice_id}} is due {{date}}." ' +
    'Call with variables: \'{"name":"Alice","invoice_id":"INV-001","date":"2026-04-15"}\'',
  parameters: {
    type: "object",
    properties: {
      template_path: { type: "string", description: "Path to template .docx file containing {{placeholder}} markers" },
      output_path: { type: "string", description: "Output .docx file path for the filled document" },
      variables: {
        type: "string",
        description: 'JSON string of key:value pairs. Keys must match {{placeholders}} in template. Example: \'{"name":"Alice","date":"2026-01-01"}\'',
      },
      images: IMAGES_PARAM_SCHEMA,
    },
    required: ["template_path", "output_path", "variables"],
  },
  async execute(args) {
    try {
      const templatePath = resolvePath(String(args.template_path));
      const outputPath = resolvePath(String(args.output_path));
      let vars: Record<string, string>;

      try {
        vars = JSON.parse(String(args.variables));
      } catch {
        return err("variables must be a valid JSON object string");
      }

      const acquired = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);
      const result = await mammoth.extractRawText({ path: templatePath });
      let text = result.value;
      let totalReplacements = 0;

      for (const [key, value] of Object.entries(vars)) {
        const placeholder = `{{${key}}}`;
        const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(escaped, "g");
        const matches = text.match(re);
        totalReplacements += matches ? matches.length : 0;
        text = text.replace(re, String(value));
      }

      await mkdir(dirname(outputPath), { recursive: true });
      const doc = buildDocument(text, undefined, acquired);
      const buffer = await Packer.toBuffer(doc);
      await writeFile(outputPath, buffer);

      const keys = Object.keys(vars).join(", ");
      const imgSuffix = acquired.length ? ` Embedded ${acquired.length} image(s).` : "";
      return ok(
        `Created ${outputPath} from template ${templatePath}. ` +
          `Replaced ${totalReplacements} placeholder(s) for keys: ${keys}.${imgSuffix}`,
      );
    } catch (e: unknown) {
      return err(`Failed to apply template: ${(e as Error).message}`);
    }
  },
};

export const documentTools: ToolDefinition[] = [
  documentCreate,
  documentRead,
  documentEdit,
  documentTemplate,
];
