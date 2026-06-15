import { dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { ToolDefinition, ToolResult } from "../types.js";
import { acquireImages, IMAGES_PARAM_SCHEMA, type ImageSpec } from "./shared/image-acquire.js";
// Resolve caller paths the SAME way SecurityLayer's file-access gate does
// (project-root anchored, no ~ expansion) so the gated path == the opened path.
import { resolveAgentPath as resolvePath } from "../workspace/paths.js";
import { resolveOfficeTheme, brandAuthor, brandFooter, THEME_PARAM_SCHEMA } from "./shared/office-theme.js";
import { acquireBrandLogo } from "./shared/office-brand.js";
import { applySlide, appendImageSlides, type SlideSpec, type SlideBrand } from "./shared/pptx-render.js";
import { collapseFamily } from "./shared/collapse-family.js";

// Rung-3 guard text + note block shared by the create tools: a deck that
// requested images but embedded none is a FAILURE the model must act on,
// and any partial degradation is reported, never silent.
function allImagesFailedMsg(requested: number, notes: string[]): string {
  return `Deck not written — all ${requested} requested image(s) failed to embed:\n${notes.join("\n")}\n` +
    "Run image_search for replacement URLs (pass each result's fallback URL as fallback_source), " +
    "or omit images to explicitly create without them.";
}
function noteBlock(notes: string[]): string {
  return notes.length ? `\nImage notes:\n${notes.join("\n")}` : "";
}

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
  "body?, bullets?: string[], notes?, image?: {source, fallback_source?, caption?}, " +
  "chart?: {type:'bar'|'line'|'pie'|'doughnut'|'area', categories?: string[], " +
  "series: [{name, values: number[]}], title?}}. " +
  "VISUAL BY DEFAULT: EVERY content slide should carry an `image` or a `chart` — a slide that is " +
  "only text is the exception (title/section dividers), not the norm. When a slide presents numbers, " +
  "comparisons, or trends, use a `chart` with the actual data; otherwise give it an `image` " +
  "(a web URL or workspace file path — use image_search to find URLs, and pass each result's " +
  "fallback URL as fallback_source). Run enough image searches to cover all slides. " +
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
      const specs = (args.images as ImageSpec[] | undefined) ?? [];
      const acquired = await acquireImages(specs);
      const brand: SlideBrand = { logo: (await acquireBrandLogo(theme)) ?? undefined, footer: brandFooter(theme) || undefined };
      ensureDir(fp);
      const pptx = await makePptx();
      if (args.title) pptx.title = args.title as string;
      pptx.author = (args.author as string) || brandAuthor(theme) || "";
      pptx.layout = "LAYOUT_WIDE";
      const imageNotes = [...acquired.notes];
      let slideImagesPlaced = 0;
      for (const s of slides) {
        const r = await applySlide(pptx, s, theme, brand);
        if (r.imagePlaced) slideImagesPlaced++;
        imageNotes.push(...r.notes);
      }
      appendImageSlides(pptx, acquired.images, theme);
      const requested = slides.filter((s) => s.image).length + specs.length;
      const embedded = slideImagesPlaced + acquired.images.length;
      if (requested > 0 && embedded === 0) return err(allImagesFailedMsg(requested, imageNotes));
      await pptx.writeFile({ fileName: fp });
      const chartCount = slides.filter((s) => s.chart).length;
      return ok(`Created presentation with ${slides.length + acquired.images.length} slide(s)${chartCount ? `, ${chartCount} chart(s)` : ""}: ${fp}${noteBlock(imageNotes)}`, {
        file_path: fp, slide_count: slides.length + acquired.images.length, image_count: embedded, chart_count: chartCount,
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
      const specs = (args.images as ImageSpec[] | undefined) ?? [];
      const acquired = await acquireImages(specs);
      const brand: SlideBrand = { logo: (await acquireBrandLogo(theme)) ?? undefined, footer: brandFooter(theme) || undefined };
      const outPath = resolvePath(args.file_path as string).replace(/\.pptx$/i, `_slide_${pos}.pptx`);
      ensureDir(outPath);
      const pptx = await makePptx();
      pptx.author = brandAuthor(theme) || "";
      pptx.layout = "LAYOUT_WIDE";
      const r = await applySlide(pptx, spec, theme, brand);
      appendImageSlides(pptx, acquired.images, theme);
      const imageNotes = [...acquired.notes, ...r.notes];
      const requested = (spec.image ? 1 : 0) + specs.length;
      const embedded = (r.imagePlaced ? 1 : 0) + acquired.images.length;
      if (requested > 0 && embedded === 0) return err(allImagesFailedMsg(requested, imageNotes));
      await pptx.writeFile({ fileName: outPath });
      return ok(`Created new slide file: ${outPath}${noteBlock(imageNotes)}`, { file_path: outPath, position: pos, image_count: embedded });
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
      const brand: SlideBrand = { logo: (await acquireBrandLogo(theme)) ?? undefined, footer: brandFooter(theme) || undefined };
      ensureDir(fp);
      const pptx = await makePptx();
      if (args.title) pptx.title = args.title as string;
      pptx.author = brandAuthor(theme) || "";
      pptx.layout = "LAYOUT_WIDE";
      // Outline slides are text-only (no spec.image), so the images param is
      // the only image path — acquireImages' all-failed throw is the rung-3
      // guard here.
      for (const s of slides) await applySlide(pptx, s, theme, brand);
      appendImageSlides(pptx, acquired.images, theme);
      await pptx.writeFile({ fileName: fp });
      return ok(`Created presentation from outline with ${slides.length + acquired.images.length} slide(s): ${fp}${noteBlock(acquired.notes)}`, {
        file_path: fp, slide_count: slides.length + acquired.images.length, image_count: acquired.images.length,
      });
    } catch (e) { return err(`Failed from outline: ${(e as Error).message}`); }
  },
};

// ── presentation_edit ──
interface EditOp {
  op: "replace_text" | "set_title" | "delete_slide" | "add_image_slide";
  find?: string;
  replace?: string;
  slide?: number;
  title?: string;
  image?: ImageSpec;
}

const presentationEdit: ToolDefinition = {
  name: "presentation_edit",
  description:
    "Edit an EXISTING .pptx in place — everything not touched (images, charts, theme, layout) " +
    "is preserved. Operations: " +
    '{op:"replace_text", find, replace, slide?} (slide omitted = whole deck; matches within ' +
    "single text runs, so prefer short exact fragments), " +
    '{op:"set_title", slide, title}, {op:"delete_slide", slide}, ' +
    '{op:"add_image_slide", image:{source, fallback_source?, caption?}, title?} — appends a new ' +
    "slide with a photo (find URLs via image_search; pass its fallback URL as fallback_source). " +
    "Slides are 1-based. For other layout/chart changes, regenerate with presentation_create.",
  parameters: {
    type: "object", required: ["file_path", "operations"],
    properties: {
      file_path: { type: "string", description: "Existing .pptx file path" },
      operations: { type: "string", description: 'JSON array of operations, e.g. [{"op":"replace_text","find":"Q3","replace":"Q4"},{"op":"add_image_slide","image":{"source":"https://...","fallback_source":"https://..."},"title":"Team offsite"}]' },
    },
  },
  async execute(args) {
    try {
      const fp = resolvePath(args.file_path as string);
      const ops = JSON.parse(args.operations as string) as EditOp[];
      if (!Array.isArray(ops) || ops.length === 0) return err("operations array is empty");

      if (!existsSync(fp)) {
        return err(`${fp} does not exist — presentation_edit only edits existing decks. ` +
          "Use presentation_create to make a new one.");
      }
      const { default: JSZip } = await import("jszip");
      const { replaceTextInDeck, setSlideTitle, deleteSlide, addImageSlide, slideFileNames } = await import("./shared/pptx-edit.js");
      // O_NOFOLLOW validated read — same TOCTOU posture as every other
      // caller-supplied-path reader (the path itself is pathArgs-gated).
      const { readValidatedFile } = await import("../security/validated-io.js");
      const zip = await JSZip.loadAsync(readValidatedFile(fp));
      if (slideFileNames(zip).length === 0) return err(`${fp} has no slides — not a .pptx deck?`);

      const report: string[] = [];
      for (const o of ops) {
        if (o.op === "replace_text") {
          if (!o.find || o.replace === undefined) return err('replace_text needs "find" and "replace"');
          const r = await replaceTextInDeck(zip, o.find, String(o.replace), o.slide);
          report.push(r.replacements > 0
            ? `replace_text "${o.find}": ${r.replacements} replacement(s) on slide(s) ${r.slidesTouched.join(", ")}`
            : `replace_text "${o.find}": 0 replacements — text may span formatting runs; try a shorter exact fragment`);
        } else if (o.op === "set_title") {
          if (!o.slide || o.title === undefined) return err('set_title needs "slide" and "title"');
          await setSlideTitle(zip, o.slide, String(o.title));
          report.push(`set_title slide ${o.slide}: "${o.title}"`);
        } else if (o.op === "delete_slide") {
          if (!o.slide) return err('delete_slide needs "slide"');
          await deleteSlide(zip, o.slide);
          report.push(`delete_slide ${o.slide}: removed`);
        } else if (o.op === "add_image_slide") {
          if (!o.image?.source) return err('add_image_slide needs "image" with a "source" (use image_search to find URLs)');
          const acquired = await acquireImages([o.image]);
          const img = acquired.images[0];
          if (img.mimeType !== "image/png" && img.mimeType !== "image/jpeg" && img.mimeType !== "image/gif") {
            return err(`add_image_slide: ${img.mimeType} can't be embedded in PowerPoint — find a png/jpeg image instead`);
          }
          const pos = await addImageSlide(zip, {
            buffer: img.buffer, mimeType: img.mimeType, width: img.width, height: img.height,
            title: o.title, caption: img.caption, alt: img.alt,
          });
          report.push(`add_image_slide: new slide ${pos} with ${img.source}`);
          report.push(...acquired.notes);
        } else {
          return err(`Unknown op "${(o as { op?: string }).op}" — use replace_text | set_title | delete_slide | add_image_slide`);
        }
      }

      const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      writeFileSync(fp, out);
      return ok(`Edited ${fp}:\n${report.join("\n")}`, { file_path: fp, operations: ops.length });
    } catch (e) { return err(`Failed to edit presentation: ${(e as Error).message}`); }
  },
};

// One collapsed tool (action param) — the four defs above stay as the
// per-action implementations. All actions write file_path (see
// tool-policies.apps.ts pathArgs); keep both in sync when adding an action.
export const presentationTools: ToolDefinition[] = [
  collapseFamily({
    name: "presentation",
    intro: "Create and edit PowerPoint (.pptx) presentations. For advanced custom layouts beyond these actions, a Node build script may use pptxgenjs directly — it's bundled, so `require('pptxgenjs')` by bare name (never an absolute cwd/node_modules path).",
    actions: {
      create: presentationCreate,
      add_slide: presentationAddSlide,
      from_outline: presentationFromOutline,
      edit: presentationEdit,
    },
    fullActionDocs: true,
    properties: {
      file_path: { type: "string", description: "Path to the .pptx file (output for create/from_outline, existing for edit/add_slide)" },
      title: { type: "string", description: "(create/from_outline/add_slide) Presentation title metadata" },
      author: { type: "string", description: "(create) Author metadata" },
      slides: { type: "string", description: "(create) JSON array of slide specs (see action docs — prefer charts/images over bullet walls)" },
      slide: { type: "string", description: "(add_slide) JSON slide spec" },
      position: { type: "number", description: "(add_slide) Slide position number for filename suffix" },
      outline: { type: "string", description: "(from_outline) Markdown outline — # starts a new slide, - for bullets, \\n line breaks" },
      operations: { type: "string", description: "(edit) JSON array of operations (replace_text | set_title | delete_slide | add_image_slide)" },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
    },
    required: ["file_path"],
  }),
];
