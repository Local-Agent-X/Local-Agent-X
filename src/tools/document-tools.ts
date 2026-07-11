import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import * as docx from "docx";
import mammoth from "mammoth";
import type { ToolDefinition, ToolResult } from "../types.js";
import { acquireImages, imageAltText, IMAGES_PARAM_SCHEMA, type AcquiredImage, type ImageSpec } from "./shared/image-acquire.js";
import { verifyWriteLanded } from "./verify.js";
// Resolve caller paths the SAME way SecurityLayer's file-access gate does
// (project-root anchored, no ~ expansion) so the gated path == the opened path.
import { resolveAgentPath as resolvePath } from "../workspace/paths.js";
import { readValidatedFile } from "../security/layer/index.js";
import { resolveOfficeTheme, half, brandAuthor, brandFooter, type OfficeTheme, THEME_PARAM_SCHEMA } from "./shared/office-theme.js";
import { acquireBrandLogo, logoSize } from "./shared/office-brand.js";
import { markdownToDocx } from "./shared/md-to-docx.js";
import { collapseFamily } from "./shared/collapse-family.js";

const { Document, Packer, Paragraph, TextRun, ImageRun, BorderStyle, Header, Footer, PageNumber, AlignmentType } = docx;

function logoImageRun(img: AcquiredImage, heightPx: number): docx.ImageRun {
  const { w, h } = logoSize(img, heightPx);
  const type: "png" | "jpg" | "gif" = img.mimeType === "image/jpeg" ? "jpg" : img.mimeType === "image/gif" ? "gif" : "png";
  const alt = "Logo";
  return new ImageRun({ type, data: img.buffer, transformation: { width: w, height: h }, altText: { title: alt, description: alt, name: alt } } as docx.IImageOptions);
}

/** Section header (logo, right-aligned) + footer (company + page number),
 *  built only as the brand/page-numbering needs them. */
function sectionExtras(theme: OfficeTheme, logo: AcquiredImage | null): { headers?: { default: docx.Header }; footers: { default: docx.Footer } } {
  const footerText = brandFooter(theme);
  const footerRuns: docx.TextRun[] = [];
  if (footerText) footerRuns.push(new TextRun({ text: `${footerText}    `, size: half(9), color: theme.colors.muted }));
  footerRuns.push(new TextRun({ children: [PageNumber.CURRENT], size: half(9), color: theme.colors.muted }));
  const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: footerRuns })] });
  if (!logo) return { footers: { default: footer } };
  const header = new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [logoImageRun(logo, 34)] })] });
  return { headers: { default: header }, footers: { default: footer } };
}

/** Document-level style sheet derived from the theme: body font/size/color +
 *  spacing, and the three heading levels (H1 carries the accent underline). */
function docStyles(t: OfficeTheme): NonNullable<docx.IPropertiesOptions["styles"]> {
  const headingRun = (size: number, color: string) =>
    ({ font: t.fonts.heading, size: half(size), bold: true, color });
  return {
    default: {
      document: {
        run: { font: t.fonts.body, size: half(t.doc.bodySize), color: t.colors.body },
        paragraph: { spacing: { line: Math.round(t.doc.lineSpacing * 240), lineRule: "auto", after: 120 } },
      },
    },
    paragraphStyles: [
      {
        id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: headingRun(t.doc.h1Size, t.colors.heading),
        paragraph: {
          spacing: { before: 280, after: 80 },
          border: { bottom: { color: t.colors.accent, size: 12, space: 4, style: BorderStyle.SINGLE } },
        },
      },
      {
        id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: headingRun(t.doc.h2Size, t.colors.subheading),
        paragraph: { spacing: { before: 220, after: 60 } },
      },
      {
        id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: t.fonts.heading, size: half(t.doc.h3Size), bold: true, color: t.colors.accent },
        paragraph: { spacing: { before: 160, after: 40 } },
      },
    ],
  };
}

/** Styled document title (uses the `title` arg) — larger than H1, accent rule. */
function titleParagraph(t: OfficeTheme, title: string): docx.Paragraph {
  return new Paragraph({
    spacing: { after: 160 },
    border: { bottom: { color: t.colors.accent, size: 18, space: 6, style: BorderStyle.SINGLE } },
    children: [new TextRun({ text: title, bold: true, font: t.fonts.heading, size: half(t.doc.titleSize), color: t.colors.heading })],
  });
}

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
  const alt = imageAltText(img);
  return new ImageRun({
    type,
    data: img.buffer,
    transformation: { width: w, height: h },
    altText: { title: alt, description: alt, name: alt },
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

// ── Document assembly ──

function buildDocument(
  text: string,
  title?: string,
  images: AcquiredImage[] = [],
  theme: OfficeTheme = resolveOfficeTheme(),
  logo: AcquiredImage | null = null,
): docx.Document {
  const children = [
    ...(title ? [titleParagraph(theme, title)] : []),
    ...markdownToDocx(text, theme),
    ...imageParagraphs(images),
  ];

  return new Document({
    // The USER's brand (or empty) — never the app name.
    creator: brandAuthor(theme),
    title: title ?? "Document",
    styles: docStyles(theme),
    sections: [{ properties: {}, ...sectionExtras(theme, logo), children }],
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
      theme: THEME_PARAM_SCHEMA,
    },
    required: ["file_path", "content"],
  },
  async execute(args) {
    try {
      const filePath = resolvePath(String(args.file_path));
      const content = String(args.content);
      const title = args.title ? String(args.title) : undefined;
      const theme = resolveOfficeTheme(args.theme);
      const acquired = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);
      const logo = await acquireBrandLogo(theme);

      await mkdir(dirname(filePath), { recursive: true });
      const doc = buildDocument(content, title, acquired.images, theme, logo);
      const buffer = await Packer.toBuffer(doc);
      await writeFile(filePath, buffer);

      const lineCount = content.split("\n").filter((l) => l.trim()).length;
      const imgSuffix = acquired.images.length ? `, ${acquired.images.length} image(s)` : "";
      const notes = acquired.notes.length ? `\nImage notes:\n${acquired.notes.join("\n")}` : "";
      return ok(`Created ${filePath} (${lineCount} content lines${imgSuffix}, ${buffer.length} bytes)${notes}`);
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
      // Read the VALIDATED canonical inode (realpath + O_NOFOLLOW leaf) and feed
      // mammoth the bytes, so a symlink swapped in after the gate (R4-19) is
      // rejected rather than extracted.
      const result = await mammoth.extractRawText({ buffer: readValidatedFile(filePath) });
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

      // Read the VALIDATED canonical inode (realpath + O_NOFOLLOW leaf) so a
      // symlink swap after the gate (R4-19) is rejected rather than read.
      const result = await mammoth.extractRawText({ buffer: readValidatedFile(filePath) });
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

      const verified = verifyWriteLanded(filePath, { minBytes: 1000 });
      if (!verified.ok) return err(`Failed to edit document: ${verified.reason}`);

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

      const { images: acquired, notes: imageNotes } = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);
      // Read the VALIDATED canonical inode of the template (realpath +
      // O_NOFOLLOW leaf) so a symlink swap after the gate (R4-19) is rejected.
      const result = await mammoth.extractRawText({ buffer: readValidatedFile(templatePath) });
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
      const notes = imageNotes.length ? `\nImage notes:\n${imageNotes.join("\n")}` : "";
      return ok(
        `Created ${outputPath} from template ${templatePath}. ` +
          `Replaced ${totalReplacements} placeholder(s) for keys: ${keys}.${imgSuffix}${notes}`,
      );
    } catch (e: unknown) {
      return err(`Failed to apply template: ${(e as Error).message}`);
    }
  },
};

// One collapsed tool (action param) — the four defs above stay as the
// per-action implementations. pathArgs gating is action-conditional
// (forActions in tool-policies.apps.ts); keep both in sync when adding
// an action.
export const documentTools: ToolDefinition[] = [
  collapseFamily({
    name: "document",
    intro: "Create, read, edit, and template-fill Word .docx documents. For advanced custom layouts beyond these actions, a Node build script may use docx directly — it's bundled, so `require('docx')` by bare name (never an absolute cwd/node_modules path).",
    actions: {
      create: documentCreate,
      read: documentRead,
      edit: documentEdit,
      template: documentTemplate,
    },
    fullActionDocs: true,
    properties: {
      file_path: { type: "string", description: "(create/read/edit) Path to the .docx file" },
      title: { type: "string", description: "(create) Document title metadata" },
      content: { type: "string", description: "(create) Formatted text with \\n newlines. Use # for headings, - for bullets, **bold** for emphasis. Separate sections with blank lines (\\n\\n)." },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
      find: { type: "string", description: "(edit) Text to find" },
      replace: { type: "string", description: "(edit) Replacement text" },
      template_path: { type: "string", description: "(template) Path to template .docx containing {{placeholder}} markers" },
      output_path: { type: "string", description: "(template) Output .docx path for the filled document" },
      variables: { type: "string", description: '(template) JSON string of key:value pairs matching {{placeholders}}. Example: \'{"name":"Alice","date":"2026-01-01"}\'' },
    },
  }),
];
