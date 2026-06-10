import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { ToolDefinition, ToolResult } from "../types.js";
import { acquireImages, IMAGES_PARAM_SCHEMA, type ImageSpec } from "./shared/image-acquire.js";
// Resolve caller paths the SAME way SecurityLayer's file-access gate does
// (project-root anchored, no ~ expansion) so the gated path == the opened path.
import { resolveAgentPath as resolvePath } from "../workspace/paths.js";
import { resolveOfficeTheme, THEME_PARAM_SCHEMA } from "./shared/office-theme.js";
import { applySlide, appendImageSlides, type SlideSpec } from "./shared/pptx-render.js";

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

function ensureDir(p: string): void { mkdirSync(dirname(p), { recursive: true }); }

// Shared guidance appended to the create-tool descriptions so the model builds
// VISUAL slides by default instead of walls of text.
const SLIDE_SPEC_DOC =
  "Each slide spec: {title?, layout?: 'title'|'section'|'content'|'blank', " +
  "body?, bullets?: string[], notes?, image?: {source, caption?}, " +
  "chart?: {type:'bar'|'line'|'pie'|'doughnut'|'area', categories?: string[], " +
  "series: [{name, values: number[]}], title?}}. " +
  "VISUAL BY DEFAULT: when a slide presents numbers, comparisons, or trends, add a `chart` " +
  "with the actual data — do NOT make a slide that is just 3-4 bullets of figures. " +
  "Add an `image` (a web URL or a workspace file path) when a picture would strengthen the point — " +
  "use the image_search tool to find a relevant image URL if you don't have one. " +
  "Keep bullets short (≤5 per slide, one line each). image+text or chart+text auto-lay side by side.";

// ── presentation_create ──
const presentationCreate: ToolDefinition = {
  name: "presentation_create",
  description:
    "Create a PowerPoint (.pptx) presentation with one or more slides. " + SLIDE_SPEC_DOC,
  parameters: {
    type: "object", required: ["file_path", "slides"],
    properties: {
      file_path: { type: "string", description: "Output .pptx file path" },
      title: { type: "string", description: "Presentation title metadata" },
      author: { type: "string", description: "Author metadata" },
      slides: { type: "string", description: "JSON array of slide specs (see description for shape — prefer charts/images over bullet walls)" },
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
      for (const s of slides) await applySlide(pptx, s, theme);
      appendImageSlides(pptx, acquired, theme);
      await pptx.writeFile({ fileName: fp });
      const chartCount = slides.filter((s) => s.chart).length;
      return ok(`Created presentation with ${slides.length + acquired.length} slide(s)${chartCount ? `, ${chartCount} chart(s)` : ""}: ${fp}`, {
        file_path: fp, slide_count: slides.length + acquired.length, image_count: acquired.length, chart_count: chartCount,
      });
    } catch (e) { return err(`Failed to create presentation: ${(e as Error).message}`); }
  },
};

// ── presentation_add_slide ──
const presentationAddSlide: ToolDefinition = {
  name: "presentation_add_slide",
  description:
    "Create a new single-slide .pptx file (pptxgenjs cannot modify existing files). " +
    "The new file is saved alongside the original with a position suffix. " + SLIDE_SPEC_DOC,
  parameters: {
    type: "object", required: ["file_path", "slide"],
    properties: {
      file_path: { type: "string", description: "Original .pptx path (derives output name)" },
      slide: { type: "string", description: "JSON slide spec (see description for shape)" },
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
      await applySlide(pptx, spec, theme);
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
    'Example: "# Welcome\\nOur product overview\\n# Features\\n- Fast\\n- Secure\\n- Easy". ' +
    "This makes text-only slides; for charts/images use presentation_create.",
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
      for (const s of slides) await applySlide(pptx, s, theme);
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
