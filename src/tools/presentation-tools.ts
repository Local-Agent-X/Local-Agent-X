import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { ToolDefinition, ToolResult } from "../types.js";
import { acquireImages, IMAGES_PARAM_SCHEMA, type AcquiredImage, type ImageSpec } from "./shared/image-acquire.js";
// Resolve caller paths the SAME way SecurityLayer's file-access gate does
// (project-root anchored, no ~ expansion) so the gated path == the opened path.
import { resolveAgentPath as resolvePath } from "../workspace/paths.js";
import { resolveOfficeTheme, type OfficeTheme, THEME_PARAM_SCHEMA } from "./shared/office-theme.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function makePptx(): Promise<any> {
  const mod = await import("pptxgenjs");
  const Ctor = (mod as any).default ?? mod;
  return new Ctor();
}

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, metadata };
}
function err(content: string): ToolResult { return { content, isError: true }; }

interface SlideSpec {
  title?: string; body?: string; bullets?: string[];
  notes?: string; layout?: "title" | "content" | "section" | "blank";
}

// LAYOUT_WIDE canvas is 13.333 × 7.5 inches.
const SLIDE_W = 13.333;

/** A short accent rule (navy bar) used under titles to anchor the layout. */
function accentBar(slide: any, t: OfficeTheme, x: number, y: number, w = 2.0): void {
  slide.addShape("rect", { x, y, w, h: 0.07, fill: { color: t.colors.accent }, line: { type: "none" } });
}

function applySlide(pptx: any, spec: SlideSpec, t: OfficeTheme): void {
  const slide = pptx.addSlide();
  const layout = spec.layout ?? "content";
  if (layout === "title") {
    slide.addText(spec.title ?? "", {
      x: 0.7, y: 2.7, w: SLIDE_W - 1.4, h: 1.5,
      fontSize: t.ppt.titleSlideSize, fontFace: t.fonts.heading, color: t.colors.heading, bold: true,
    });
    accentBar(slide, t, 0.72, 4.2, 2.4);
    if (spec.body) slide.addText(spec.body, {
      x: 0.7, y: 4.45, w: SLIDE_W - 1.4, h: 1, fontSize: t.ppt.subtitleSize, fontFace: t.fonts.body, color: t.colors.muted,
    });
  } else if (layout === "section") {
    slide.addText(spec.title ?? "", {
      x: 0.7, y: 3.0, w: SLIDE_W - 1.4, h: 1.5,
      fontSize: t.ppt.sectionSize, fontFace: t.fonts.heading, color: t.colors.accent, bold: true, align: "center",
    });
    accentBar(slide, t, SLIDE_W / 2 - 1.1, 4.55, 2.2);
  } else if (layout === "blank") {
    if (spec.body) slide.addText(spec.body, {
      x: 0.7, y: 0.6, w: SLIDE_W - 1.4, h: 6, fontSize: t.ppt.bodySize, fontFace: t.fonts.body, color: t.colors.body,
    });
  } else {
    if (spec.title) {
      slide.addText(spec.title, {
        x: 0.6, y: 0.4, w: SLIDE_W - 1.2, h: 0.8, fontSize: t.ppt.titleSize, fontFace: t.fonts.heading, color: t.colors.heading, bold: true,
      });
      accentBar(slide, t, 0.62, 1.18, 1.6);
    }
    const top = spec.title ? 1.5 : 0.6;
    if (spec.body) slide.addText(spec.body, {
      x: 0.6, y: top, w: SLIDE_W - 1.2, h: 1.5, fontSize: t.ppt.bodySize, fontFace: t.fonts.body, color: t.colors.body,
    });
    if (spec.bullets?.length) {
      const items = spec.bullets.map((b) => ({
        text: b, options: { fontSize: t.ppt.bulletSize, fontFace: t.fonts.body, color: t.colors.body, bullet: { indent: 18 } },
      }));
      slide.addText(items, { x: 0.7, y: spec.body ? top + 1.6 : top, w: SLIDE_W - 1.4, h: 4, lineSpacingMultiple: 1.3 });
    }
  }
  if (spec.notes) slide.addNotes(spec.notes);
}

function ensureDir(p: string): void { mkdirSync(dirname(p), { recursive: true }); }

/** Add each acquired image to the deck on its own slide, centered with caption. */
function appendImageSlides(pptx: any, images: AcquiredImage[], t: OfficeTheme): void {
  for (const img of images) {
    const slide = pptx.addSlide();
    const data = `data:${img.mimeType};base64,${img.buffer.toString("base64")}`;
    const slideH = 7.5; // LAYOUT_WIDE in inches
    const ratio = img.width > 0 && img.height > 0 ? img.width / img.height : 4 / 3;
    const maxW = SLIDE_W - 1, maxH = slideH - 2;
    let w = maxW, h = maxW / ratio;
    if (h > maxH) { h = maxH; w = maxH * ratio; }
    const x = (SLIDE_W - w) / 2;
    const y = (slideH - h) / 2 - 0.3;
    slide.addImage({ data, x, y, w, h });
    if (img.caption) {
      slide.addText(img.caption, {
        x: 0.5, y: y + h + 0.2, w: SLIDE_W - 1, h: 0.6,
        fontSize: t.ppt.subtitleSize, fontFace: t.fonts.body, color: t.colors.muted, align: "center", italic: true,
      });
    }
  }
}

// ── presentation_create ──
const presentationCreate: ToolDefinition = {
  name: "presentation_create",
  description: "Create a PowerPoint (.pptx) presentation with one or more slides.",
  parameters: {
    type: "object", required: ["file_path", "slides"],
    properties: {
      file_path: { type: "string", description: "Output .pptx file path" },
      title: { type: "string", description: "Presentation title metadata" },
      author: { type: "string", description: "Author metadata" },
      slides: { type: "string", description: "JSON array of slide specs" },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
    },
  },
  async execute(args) {
    try {
      const fp = resolvePath(args.file_path as string);
      const slides = JSON.parse(args.slides as string) as SlideSpec[];
      if (!slides.length) return err("slides array is empty");
      const theme = resolveOfficeTheme(args.theme);
      const acquired = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);
      ensureDir(fp);
      const pptx = await makePptx();
      if (args.title) pptx.title = args.title as string;
      if (args.author) pptx.author = args.author as string;
      pptx.layout = "LAYOUT_WIDE";
      for (const s of slides) applySlide(pptx, s, theme);
      appendImageSlides(pptx, acquired, theme);
      await pptx.writeFile({ fileName: fp });
      return ok(`Created presentation with ${slides.length + acquired.length} slide(s): ${fp}`, {
        file_path: fp, slide_count: slides.length + acquired.length, image_count: acquired.length,
      });
    } catch (e) { return err(`Failed to create presentation: ${(e as Error).message}`); }
  },
};

// ── presentation_add_slide ──
const presentationAddSlide: ToolDefinition = {
  name: "presentation_add_slide",
  description:
    "Create a new single-slide .pptx file (pptxgenjs cannot modify existing files). " +
    "The new file is saved alongside the original with a position suffix.",
  parameters: {
    type: "object", required: ["file_path", "slide"],
    properties: {
      file_path: { type: "string", description: "Original .pptx path (derives output name)" },
      slide: { type: "string", description: "JSON slide spec" },
      position: { type: "number", description: "Slide position number for filename suffix" },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
    },
  },
  async execute(args) {
    try {
      const spec = JSON.parse(args.slide as string) as SlideSpec;
      const pos = (args.position as number) ?? 2;
      const theme = resolveOfficeTheme(args.theme);
      const acquired = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);
      const outPath = resolvePath(args.file_path as string).replace(/\.pptx$/i, `_slide_${pos}.pptx`);
      ensureDir(outPath);
      const pptx = await makePptx();
      pptx.layout = "LAYOUT_WIDE";
      applySlide(pptx, spec, theme);
      appendImageSlides(pptx, acquired, theme);
      await pptx.writeFile({ fileName: outPath });
      return ok(`Created new slide file: ${outPath}`, { file_path: outPath, position: pos, image_count: acquired.length });
    } catch (e) { return err(`Failed to add slide: ${(e as Error).message}`); }
  },
};

// ── presentation_from_outline ──

/** Pre-process outline text so flat/unformatted input still parses.
 *  Ensures # headings and - bullets each start on their own line. */
function normalizeOutline(raw: string): string {
  if (/^#+\s/m.test(raw)) return raw;   // already markdown
  return raw
    .replace(/\s+(#{1,3}\s)/g, "\n$1")
    .replace(/\s+[-*]\s+/g, "\n- ")
    .replace(/([.!?])\s+([A-Z])/g, "$1\n$2");
}

function outlineToSlides(md: string): SlideSpec[] {
  const slides: SlideSpec[] = [];
  let cur: SlideSpec | null = null;
  let first = true;
  for (const raw of normalizeOutline(md).split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) {
      if (cur) slides.push(cur);
      cur = { title: line.slice(2).trim(), layout: first ? "title" : "content" };
      first = false;
    } else if (line.startsWith("## ")) {
      if (cur) slides.push(cur);
      cur = { title: line.slice(3).trim(), layout: "section" };
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!cur) cur = { layout: "content" };
      (cur.bullets ??= []).push(line.replace(/^\s*[-*]\s+/, ""));
    } else if (line.trim()) {
      if (!cur) cur = { layout: "content" };
      cur.body = cur.body ? `${cur.body}\n${line.trim()}` : line.trim();
    }
  }
  if (cur) slides.push(cur);
  return slides;
}

const presentationFromOutline: ToolDefinition = {
  name: "presentation_from_outline",
  description:
    "Auto-generate a PowerPoint presentation from a markdown outline. " +
    "IMPORTANT: The outline MUST use markdown formatting with newlines. " +
    "Use '# Title' for slide titles (each # starts a new slide), " +
    "'- item' for bullet points under that slide. " +
    'Example: "# Welcome\\nOur product overview\\n# Features\\n- Fast\\n- Secure\\n- Easy"',
  parameters: {
    type: "object", required: ["file_path", "outline"],
    properties: {
      file_path: { type: "string", description: "Output .pptx file path" },
      outline: { type: "string", description: "Markdown outline with # for slide titles and - for bullets. Each # starts a new slide. Use \\n for line breaks." },
      title: { type: "string", description: "Presentation title metadata" },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
    },
  },
  async execute(args) {
    try {
      const fp = resolvePath(args.file_path as string);
      const slides = outlineToSlides(args.outline as string);
      if (!slides.length) return err("Outline produced no slides");
      const theme = resolveOfficeTheme(args.theme);
      const acquired = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);
      ensureDir(fp);
      const pptx = await makePptx();
      if (args.title) pptx.title = args.title as string;
      pptx.layout = "LAYOUT_WIDE";
      for (const s of slides) applySlide(pptx, s, theme);
      appendImageSlides(pptx, acquired, theme);
      await pptx.writeFile({ fileName: fp });
      return ok(`Created presentation from outline with ${slides.length + acquired.length} slide(s): ${fp}`, {
        file_path: fp, slide_count: slides.length + acquired.length, image_count: acquired.length,
      });
    } catch (e) { return err(`Failed from outline: ${(e as Error).message}`); }
  },
};

export const presentationTools: ToolDefinition[] = [
  presentationCreate, presentationAddSlide, presentationFromOutline,
];
