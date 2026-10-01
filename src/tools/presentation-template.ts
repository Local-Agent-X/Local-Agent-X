// The presentation tool's from_template action: a new deck that keeps an
// existing deck's masters, theme, layouts and media, with the slides the
// caller names kept and new slides laid out on the template's own layouts.
// Lives beside presentation-tools.ts (which is at the size cap); the family
// collapse there registers it. Both paths are gated: template_path as a read,
// file_path as a write (tool-policies.apps.ts pathArgs).
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveAgentPath as resolvePath } from "../workspace/paths.js";
import { acquireImages, IMAGES_PARAM_SCHEMA, type ImageSpec } from "./shared/image-acquire.js";
import { deckFromTemplate, type TemplateSlide } from "./shared/pptx-template.js";
import { addImageSlide } from "./shared/pptx-edit.js";
import { outlineToSlides } from "./presentation-outline.js";

function err(content: string, metadata?: Record<string, unknown>): ToolResult { return { content, isError: true, metadata }; }

function parseKeep(raw: unknown): number[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw) : [raw];
  if (!Array.isArray(list)) throw new Error("keep_slides must be a JSON array of 1-based slide numbers");
  return list.map(Number);
}

function parseSlides(args: Record<string, unknown>): TemplateSlide[] {
  if (typeof args.outline === "string" && args.outline.trim()) {
    return outlineToSlides(args.outline).map((s) => ({ layout: s.layout, title: s.title, bullets: s.bullets, body: s.body }));
  }
  if (typeof args.slides === "string" && args.slides.trim()) {
    const parsed = JSON.parse(args.slides) as TemplateSlide[];
    if (!Array.isArray(parsed)) throw new Error("slides must be a JSON array of slide specs");
    return parsed;
  }
  return [];
}

export const presentationFromTemplate: ToolDefinition = {
  name: "presentation_from_template",
  description:
    "Create a NEW .pptx from an EXISTING deck's template: the output keeps the template's masters, theme, " +
    "layouts, fonts and media. keep_slides names the template slides to carry over (1-based; default none). " +
    "New slides come from outline (markdown: # title slide, ## section, - bullets) or slides (JSON array of " +
    "{layout?: 'title'|'section'|'content'|'blank', title?, bullets?, body?}) and are laid out on the template's " +
    "own layouts, so they match its look. images:[{source,caption}] are appended as photo slides. " +
    "Use this when the user gives you a branded deck to start from; use create for a fresh theme.",
  parameters: {
    type: "object", required: ["file_path", "template_path"],
    properties: {
      template_path: { type: "string", description: "Existing .pptx to start from (its slides, theme and media are the source)" },
      file_path: { type: "string", description: "Output .pptx path (must differ from template_path)" },
      keep_slides: { type: "string", description: "JSON array of 1-based template slide numbers to keep, e.g. [1,2]. Omit to keep none." },
      outline: { type: "string", description: "Markdown outline for the new slides — # starts a slide, ## a section, - a bullet" },
      slides: { type: "string", description: "JSON array of slide specs for the new slides (alternative to outline)" },
      images: IMAGES_PARAM_SCHEMA,
    },
  },
  async execute(args) {
    try {
      const templatePath = resolvePath(args.template_path as string);
      const fp = resolvePath(args.file_path as string);
      if (templatePath.toLowerCase() === fp.toLowerCase()) return err("file_path must differ from template_path — from_template writes a new deck and never overwrites the template");
      if (!existsSync(templatePath)) return err(`${templatePath} does not exist — template_path must be an existing .pptx`);
      const keep = parseKeep(args.keep_slides);
      const slides = parseSlides(args);
      const specs = (args.images as ImageSpec[] | undefined) ?? [];
      // O_NOFOLLOW validated read — the path itself is pathArgs-gated as a read.
      const { readValidatedFile } = await import("../security/layer/index.js");
      const { zip, result } = await deckFromTemplate(readValidatedFile(templatePath), keep, slides);
      const notes: string[] = [];
      let imageCount = 0;
      if (specs.length) {
        const acquired = await acquireImages(specs);
        notes.push(...acquired.notes);
        for (const img of acquired.images) {
          if (img.mimeType !== "image/png" && img.mimeType !== "image/jpeg" && img.mimeType !== "image/gif") { notes.push(`${img.source}: ${img.mimeType} can't be embedded in PowerPoint — skipped`); continue; }
          await addImageSlide(zip, { buffer: img.buffer, mimeType: img.mimeType, width: img.width, height: img.height, caption: img.caption, alt: img.alt });
          imageCount++;
        }
      }
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
      const total = result.slides + imageCount;
      const summary = `Created ${fp} from template ${templatePath}: ${total} slide(s) — kept ${result.kept.length ? result.kept.join(", ") : "none"} of the template's, ` +
        `added ${result.added} on its layouts (${result.layoutsUsed.join(", ") || "none"})${imageCount ? `, ${imageCount} photo slide(s)` : ""}.` +
        (notes.length ? `\nImage notes:\n${notes.join("\n")}` : "");
      return { content: summary, metadata: { file_path: fp, template_path: templatePath, slide_count: total, kept: result.kept, added: result.added, image_count: imageCount } };
    } catch (e) { return err(`Failed from template: ${(e as Error).message}`); }
  },
};
