import { dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { ToolDefinition, ToolResult } from "../types.js";
import { acquireImages, AllImagesFailedError, IMAGES_PARAM_SCHEMA, type AcquireOutcome, type ImageSpec } from "./shared/image-acquire.js";
// Resolve caller paths the SAME way SecurityLayer's file-access gate does
// (workspace anchored, no ~ expansion) so the gated path == the opened path.
import { resolveAgentPath as resolvePath, sessionIdOf } from "../workspace/paths.js";
import { resolveOfficeTheme, brandAuthor, brandFooter, THEME_PARAM_SCHEMA } from "./shared/office-theme.js";
import { acquireBrandLogo } from "./shared/office-brand.js";
import { buildDeck, SLIDE_LAYOUTS, type SlideSpec } from "./shared/pptx-render.js";
import type { SlideBrand } from "./shared/slide-layout-kit.js";
import { previewDeck, type DeckPreview } from "./shared/deck-preview.js";
import { collapseFamily } from "./shared/collapse-family.js";
import { SOURCES_DOC_SENTENCE, SOURCES_PARAM_SCHEMA } from "./shared/provenance-sources.js";
import { outlineToSlides } from "./presentation-outline.js";
import { presentationFromTemplate } from "./presentation-template.js";

/**
 * Every requested image failed. The deck is still WRITTEN — the user asked for
 * slides and the text is fine — but the result stays a FAILURE so the model
 * cannot report an illustrated deck it did not produce. Destroying the file too
 * was pure loss: a live 27B lost nine good slides to three 404s, rebuilt the
 * identical outline imageless, and the user read the exchange as the model
 * lying about a deck that did in fact exist (2026-09-19).
 *
 * "error" is the right envelope for a call that DID land: only "declined" means
 * nothing happened (dispatch-tools.ts NEVER_LANDED), so an errored call is
 * already understood to have possibly had side effects.
 */
function allImagesFailedMsg(requested: number, notes: string[], filePath: string): string {
  return `Deck written WITHOUT images — all ${requested} requested image(s) failed: ${filePath}\n${notes.join("\n")}\n` +
    "The slides and text are intact; only the images are missing. Add them to the EXISTING file with the " +
    "edit action's add_image_slide op (run image_search first for URLs that resolve — pass each result's " +
    "fallback URL as fallback_source). Do not rebuild the deck from scratch, and do not tell the user it " +
    "is illustrated.";
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
function err(content: string, metadata?: Record<string, unknown>): ToolResult { return { content, isError: true, metadata }; }

/** The rendered slides ride the result's `_images` envelope, so the model
 *  sees them with the result text, in the same call. */
function withPreview(result: ToolResult, preview: DeckPreview): ToolResult {
  return preview.images.length ? { ...result, _images: preview.images } : result;
}

function ensureDir(p: string): void { mkdirSync(dirname(p), { recursive: true }); }

// Shared guidance appended to the create-tool descriptions: what each layout
// is for, so a deck is built from the right pieces instead of one layout.
const SLIDE_SPEC_DOC =
  `Each slide spec: {layout?: ${SLIDE_LAYOUTS.map((l) => `'${l}'`).join("|")}, title?, body?, bullets?: string[], notes?, ` +
  "image?: {source, fallback_source?, caption?}, chart?: {type:'bar'|'line'|'pie'|'doughnut'|'area', categories?: string[], " +
  "series: [{name, values: number[]}], title?}, stats?: [{value, label}], columns?: [{heading, body?, bullets?}], " +
  "steps?: [{label, text?}], attribution?}. " +
  "LAYOUTS — pick the one that fits what the slide says, and mix them: 'title' the cover (title; body = tagline, then a blank " +
  "line and contact lines; an image fills its side panel); 'section' a divider; 'content' text with a photo or chart beside it " +
  "(sides alternate automatically); 'stats' 1-4 big numbers; 'columns' 2-3 side-by-side cards (comparisons, options, plans); " +
  "'timeline' 2-6 steps (roadmap, process, history); 'quote' a testimonial (body + attribution); 'statement' the one sentence " +
  "the audience must remember; 'image' a full-bleed photo with title and caption; 'closing' the ask, next steps or contact. " +
  "A deck of only 'content' slides reads as a wall: use stats for numbers, a chart for trends, columns for comparisons. " +
  "Images: a web URL or workspace path (image_search finds URLs; pass each result's fallback URL as fallback_source). " +
  "Keep slides projectable: short titles, ≤5 bullets of one line, detail in notes. Text is fitted to its box automatically.";

// ── presentation_create ──
const presentationCreate: ToolDefinition = {
  name: "presentation_create",
  description:
    "Create a PowerPoint (.pptx) presentation with one or more slides. " + SLIDE_SPEC_DOC + " " + SOURCES_DOC_SENTENCE,
  parameters: {
    type: "object", required: ["file_path", "slides"],
    properties: {
      file_path: { type: "string", description: "Output .pptx file path" },
      title: { type: "string", description: "Presentation title metadata" },
      author: { type: "string", description: "Author metadata" },
      slides: { type: "string", description: "JSON array of slide specs (see description for shape — prefer charts/images over bullet walls)" },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
      sources: SOURCES_PARAM_SCHEMA,
    },
  },
  async execute(args) {
    try {
      const fp = resolvePath(args.file_path as string, sessionIdOf(args));
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
      const deck = await buildDeck(pptx, slides, acquired.images, theme, brand);
      const imageNotes = [...acquired.notes, ...deck.notes];
      const requested = slides.filter((s) => s.image).length + specs.length;
      const embedded = deck.imagesPlaced + acquired.images.length;
      await pptx.writeFile({ fileName: fp });
      if (requested > 0 && embedded === 0) {
        return err(allImagesFailedMsg(requested, imageNotes, fp), { file_path: fp, slide_count: slides.length, image_count: 0, images_requested: requested });
      }
      const chartCount = slides.filter((s) => s.chart).length;
      const preview = await previewDeck(deck.plans, theme);
      return withPreview(ok(`Created presentation with ${deck.plans.length} slide(s)${chartCount ? `, ${chartCount} chart(s)` : ""}: ${fp}${noteBlock(imageNotes)}\n\n${preview.text}`, {
        file_path: fp, slide_count: deck.plans.length, image_count: embedded, chart_count: chartCount, slide_findings: preview.findings,
      }), preview);
    } catch (e) { return err(`Failed to create presentation: ${(e as Error).message}`); }
  },
};

// ── presentation_add_slide ──

// Output naming for add_slide: pptxgenjs cannot modify an existing file, so
// the new single-slide deck lands ALONGSIDE the original with a position
// suffix. Exported for the task-artifact recording hook
// (tool-execution/run-sandboxed.ts) — same parity contract as
// chart-tools.chartOutPath: the hook must pre-stat the SAME output path this
// tool will write, so the derivation (default position included) lives here
// once. Takes the RESOLVED original path (resolvePath'd by both callers).
export function addSlideOutPath(resolvedOriginalPath: string, position: unknown): string {
  const pos = (position as number) ?? 2;
  return resolvedOriginalPath.replace(/\.pptx$/i, `_slide_${pos}.pptx`);
}

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
      title: { type: "string", description: "Presentation title metadata for the new file" },
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
      const outPath = addSlideOutPath(resolvePath(args.file_path as string, sessionIdOf(args)), pos);
      ensureDir(outPath);
      const pptx = await makePptx();
      if (args.title) pptx.title = args.title as string;
      pptx.author = brandAuthor(theme) || "";
      pptx.layout = "LAYOUT_WIDE";
      // A single slide for another deck: no slide number of its own.
      const deck = await buildDeck(pptx, [spec], acquired.images, theme, brand, false);
      const imageNotes = [...acquired.notes, ...deck.notes];
      const requested = (spec.image ? 1 : 0) + specs.length;
      const embedded = deck.imagesPlaced + acquired.images.length;
      await pptx.writeFile({ fileName: outPath });
      if (requested > 0 && embedded === 0) {
        return err(allImagesFailedMsg(requested, imageNotes, outPath), { file_path: outPath, position: pos, image_count: 0, images_requested: requested });
      }
      const preview = await previewDeck(deck.plans, theme);
      return withPreview(ok(`Created new slide file: ${outPath}${noteBlock(imageNotes)}\n\n${preview.text}`, {
        file_path: outPath, position: pos, image_count: embedded, slide_findings: preview.findings,
      }), preview);
    } catch (e) { return err(`Failed to add slide: ${(e as Error).message}`); }
  },
};

// ── presentation_from_outline ──

const presentationFromOutline: ToolDefinition = {
  name: "presentation_from_outline",
  description:
    "Auto-generate a PowerPoint presentation from a markdown outline. " +
    "IMPORTANT: The outline MUST use markdown formatting with newlines. " +
    "Use '# Title' for slide titles (each # starts a new slide), " +
    "'- item' for bullet points under that slide. " +
    'Example: "# Welcome\\nOur product overview\\n# Features\\n- Fast\\n- Secure\\n- Easy". ' +
    "This makes text-only slides; for charts/images use presentation_create. " + SOURCES_DOC_SENTENCE,
  parameters: {
    type: "object", required: ["file_path", "outline"],
    properties: {
      file_path: { type: "string", description: "Output .pptx file path" },
      outline: { type: "string", description: "Markdown outline with # for slide titles and - for bullets. Each # starts a new slide. Use \\n for line breaks." },
      title: { type: "string", description: "Presentation title metadata" },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
      sources: SOURCES_PARAM_SCHEMA,
    },
  },
  async execute(args) {
    try {
      const fp = resolvePath(args.file_path as string, sessionIdOf(args));
      const slides = outlineToSlides(args.outline as string);
      if (!slides.length) return err("Outline produced no slides");
      const theme = resolveOfficeTheme(args.theme);
      const specs = (args.images as ImageSpec[] | undefined) ?? [];
      // A dead image URL must not cost the user the deck. Acquire, remember the
      // failure, build the slides anyway — the result below is still an error
      // when nothing embedded, so success cannot be claimed.
      let acquired: AcquireOutcome = { images: [], notes: [] };
      let allImagesFailed = false;
      try {
        acquired = await acquireImages(specs);
      } catch (e) {
        if (!(e instanceof AllImagesFailedError)) throw e;
        allImagesFailed = true;
        acquired = { images: [], notes: e.failures };
      }
      const brand: SlideBrand = { logo: (await acquireBrandLogo(theme)) ?? undefined, footer: brandFooter(theme) || undefined };
      ensureDir(fp);
      const pptx = await makePptx();
      if (args.title) pptx.title = args.title as string;
      pptx.author = brandAuthor(theme) || "";
      pptx.layout = "LAYOUT_WIDE";
      // Outline slides are text-only (no spec.image), so the images param is
      // the only image path.
      const deck = await buildDeck(pptx, slides, acquired.images, theme, brand);
      await pptx.writeFile({ fileName: fp });
      if (allImagesFailed) {
        return err(allImagesFailedMsg(specs.length, acquired.notes, fp), { file_path: fp, slide_count: slides.length, image_count: 0, images_requested: specs.length });
      }
      const preview = await previewDeck(deck.plans, theme);
      return withPreview(ok(`Created presentation from outline with ${deck.plans.length} slide(s): ${fp}${noteBlock(acquired.notes)}\n\n${preview.text}`, {
        file_path: fp, slide_count: deck.plans.length, image_count: acquired.images.length, slide_findings: preview.findings,
      }), preview);
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
      const fp = resolvePath(args.file_path as string, sessionIdOf(args));
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
      const { readValidatedFile } = await import("../security/layer/index.js");
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

// One collapsed tool (action param) — the defs above and presentation-template.ts
// stay as the per-action implementations. All actions write file_path (see
// tool-policies.apps.ts pathArgs); keep both in sync when adding an action.
export const presentationTools: ToolDefinition[] = [
  collapseFamily({
    name: "presentation",
    compactDescription: "Build and edit PowerPoint .pptx decks. actions: create, from_outline, from_template (keeps a deck's theme), add_slide, edit. THE only way to make a .pptx; never the write tool. images:[{source,caption}].",
    intro: "Create and edit PowerPoint (.pptx) presentations. For advanced custom layouts beyond these actions, a Node build script may use pptxgenjs directly — it's bundled, so `require('pptxgenjs')` by bare name (never an absolute cwd/node_modules path).",
    actions: {
      create: presentationCreate,
      add_slide: presentationAddSlide,
      from_outline: presentationFromOutline,
      from_template: presentationFromTemplate,
      edit: presentationEdit,
    },
    fullActionDocs: true,
    properties: {
      file_path: { type: "string", description: "Path to the .pptx file (output for create/from_outline/from_template, existing for edit/add_slide)" },
      template_path: { type: "string", description: "(from_template) Existing .pptx to start from" },
      keep_slides: { type: "string", description: "(from_template) JSON array of 1-based slide numbers to keep" },
      title: { type: "string", description: "(create/from_outline/add_slide) Presentation title metadata" },
      author: { type: "string", description: "(create) Author metadata" },
      slides: { type: "string", description: "(create) JSON array of slide specs (see action docs — prefer charts/images over bullet walls)" },
      slide: { type: "string", description: "(add_slide) JSON slide spec" },
      position: { type: "number", description: "(add_slide) Slide position number for filename suffix" },
      outline: { type: "string", description: "(from_outline) Markdown outline — # starts a new slide, - for bullets, \\n line breaks" },
      operations: { type: "string", description: "(edit) JSON array of operations (replace_text | set_title | delete_slide | add_image_slide)" },
      images: IMAGES_PARAM_SCHEMA,
      theme: THEME_PARAM_SCHEMA,
      sources: SOURCES_PARAM_SCHEMA,
    },
    required: ["file_path"],
  }),
];
