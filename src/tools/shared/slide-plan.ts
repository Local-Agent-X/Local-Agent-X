/**
 * A slide as geometry: the ground it is painted on and every element, placed
 * and sized, in inches on the 13.333 × 7.5 wide canvas. The layouts
 * (slide-layouts-*.ts) produce one; the PowerPoint writer (slide-emit-pptx.ts)
 * and the preview (slide-raster.ts) each turn the same plan into their output,
 * and the checks (slide-checks.ts) read it. Nothing about a slide's look is
 * decided twice.
 */
import type { AcquiredImage } from "./image-acquire.js";
import type { ChartSpec } from "./office-chart.js";
import type { OfficeTheme } from "./office-theme.js";
import { fitText, type FitResult, type Measurer } from "./slide-text-fit.js";

export const SLIDE_W = 13.333;
export const SLIDE_H = 7.5;

export interface Box { x: number; y: number; w: number; h: number }

export type Align = "left" | "center" | "right";
export type VAlign = "top" | "middle" | "bottom";

export interface TextElement {
  kind: "text";
  box: Box;
  paragraphs: string[];
  font: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
  align: Align;
  valign: VAlign;
  lineSpacing: number;
  paraGap: number;
  bullets: boolean;
  fit: FitResult;
  /** What the check names when this text is in trouble. */
  role: string;
}

export type PlanElement =
  | { kind: "rect"; box: Box; color: string; transparency?: number }
  | { kind: "ellipse"; box: Box; color: string }
  | TextElement
  | { kind: "image"; box: Box; image: AcquiredImage; alt: string }
  | { kind: "chart"; box: Box; chart: ChartSpec };

export interface SlidePlan {
  layout: string;
  background: string;
  elements: PlanElement[];
  notes?: string;
}

/** The colors a slide is painted with, from the theme. */
export interface SlidePalette {
  light: string; dark: string; band: string;
  ink: string; body: string; muted: string;
  accent: string; highlight: string;
  onDark: string; onDarkMuted: string;
}

export function slidePalette(t: OfficeTheme): SlidePalette {
  const c = t.colors;
  return {
    light: c.slideBackground, dark: c.slideDark, band: c.band,
    ink: c.heading, body: c.body, muted: c.muted,
    accent: c.accent, highlight: c.highlight,
    onDark: c.onDark, onDarkMuted: c.onDarkMuted,
  };
}

export interface TextOptions {
  font: string;
  color: string;
  size: number;
  minSize: number;
  role: string;
  bold?: boolean;
  italic?: boolean;
  align?: Align;
  valign?: VAlign;
  lineSpacing?: number;
  paraGap?: number;
  bullets?: boolean;
}

/** A text element, fitted to its box. */
export function textEl(m: Measurer, box: Box, paragraphs: string[], o: TextOptions): TextElement {
  const lineSpacing = o.lineSpacing ?? 1;
  const paraGap = o.paraGap ?? (o.bullets ? 0.45 : 0.3);
  const fit = fitText(m, {
    paragraphs, font: o.font, bold: o.bold, italic: o.italic,
    w: box.w, h: box.h, size: o.size, minSize: o.minSize,
    lineSpacing, bullets: o.bullets, paraGap,
  });
  return {
    kind: "text", box, paragraphs, font: o.font, color: o.color, bold: o.bold, italic: o.italic,
    align: o.align ?? "left", valign: o.valign ?? "top", lineSpacing, paraGap,
    bullets: !!o.bullets, fit, role: o.role,
  };
}

export function rectEl(box: Box, color: string, transparency?: number): PlanElement {
  return transparency ? { kind: "rect", box, color, transparency } : { kind: "rect", box, color };
}

/** Paragraphs of a body string: blank-line or newline separated, trimmed. */
export function paragraphsOf(text: string | undefined): string[] {
  return (text ?? "").split(/\n/).map((s) => s.trim()).filter(Boolean);
}

/** Center-crop an image to the box's aspect, so a photo fills its panel the
 *  same way in PowerPoint and in the preview. PNG stays PNG (it may carry
 *  transparency); everything else becomes JPEG, which every Office reads. */
export async function cropToBox(img: AcquiredImage, box: Box): Promise<AcquiredImage> {
  if (!(img.width > 0 && img.height > 0)) return img;
  const target = box.w / box.h;
  const ratio = img.width / img.height;
  const sharp = (await import("sharp")).default;
  let w = img.width, h = img.height;
  if (Math.abs(ratio - target) > 0.01) {
    if (ratio > target) w = Math.round(img.height * target);
    else h = Math.round(img.width / target);
  }
  const left = Math.floor((img.width - w) / 2), top = Math.floor((img.height - h) / 2);
  const pipeline = sharp(img.buffer).extract({ left, top, width: w, height: h });
  const png = img.mimeType === "image/png";
  const buffer = png ? await pipeline.png().toBuffer() : await pipeline.jpeg({ quality: 88 }).toBuffer();
  return { ...img, buffer, mimeType: png ? "image/png" : "image/jpeg", width: w, height: h };
}

/** The box an image takes inside `box` at its own aspect, centered. */
export function containBox(img: AcquiredImage, box: Box): Box {
  const ratio = img.width > 0 && img.height > 0 ? img.width / img.height : 4 / 3;
  let w = box.w, h = box.w / ratio;
  if (h > box.h) { h = box.h; w = box.h * ratio; }
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}
