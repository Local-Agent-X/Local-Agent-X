/**
 * PowerPoint slide rendering — shared by every presentation tool so layout,
 * theming, charts, and images stay consistent. Kept out of presentation-tools.ts
 * so that file stays a thin set of tool definitions under the source-size gate.
 *
 * Visual-by-default: a content slide carrying a `chart` or `image` lays text on
 * the left and the visual on the right; a visual with no text fills the body.
 * Charts are NATIVE, editable PowerPoint charts (pptxgenjs addChart), themed
 * with the house chart palette.
 */
import { acquireImages, imageAltText, AllImagesFailedError, type AcquiredImage, type ImageSpec } from "./image-acquire.js";
import type { OfficeTheme } from "./office-theme.js";
import { cleanText, toPlainText } from "./office-md.js";
import { isValidChart, type ChartSpec } from "./office-chart.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SlideSpec {
  title?: string;
  body?: string;
  bullets?: string[];
  notes?: string;
  layout?: "title" | "content" | "section" | "blank";
  /** Native chart rendered on this slide. */
  chart?: ChartSpec;
  /** Inline image (URL or workspace path) placed on this slide. */
  image?: ImageSpec;
}

// LAYOUT_WIDE canvas is 13.333 × 7.5 inches.
export const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

/** A short accent rule (navy bar) used under titles to anchor the layout. */
function accentBar(slide: any, t: OfficeTheme, x: number, y: number, w = 2.0): void {
  slide.addShape("rect", { x, y, w, h: 0.07, fill: { color: t.colors.accent }, line: { type: "none" } });
}

function renderChart(slide: any, t: OfficeTheme, chart: ChartSpec, box: { x: number; y: number; w: number; h: number }): void {
  const cats = chart.categories ?? chart.series[0].values.map((_, i) => `#${i + 1}`);
  const pie = chart.type === "pie" || chart.type === "doughnut";
  const data = (pie ? chart.series.slice(0, 1) : chart.series).map((s) => ({
    name: s.name, labels: cats, values: s.values,
  }));
  slide.addChart(chart.type, data, {
    ...box,
    chartColors: t.chartPalette,
    showLegend: pie || chart.series.length > 1,
    legendPos: "b",
    legendColor: t.colors.muted,
    showTitle: !!chart.title,
    title: chart.title ? cleanText(chart.title) : undefined,
    titleColor: t.colors.heading,
    titleFontFace: t.fonts.heading,
    titleFontSize: 14,
    showPercent: pie,
    catAxisLabelColor: t.colors.body,
    valAxisLabelColor: t.colors.body,
    catAxisLabelFontFace: t.fonts.body,
    valAxisLabelFontFace: t.fonts.body,
    chartColorsOpacity: 100,
  });
}

function placeImage(slide: any, img: AcquiredImage, box: { x: number; y: number; w: number; h: number }): void {
  const data = `data:${img.mimeType};base64,${img.buffer.toString("base64")}`;
  const ratio = img.width > 0 && img.height > 0 ? img.width / img.height : 4 / 3;
  let w = box.w, h = box.w / ratio;
  if (h > box.h) { h = box.h; w = box.h * ratio; }
  slide.addImage({ data, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h, altText: imageAltText(img) });
}

export interface SlideBrand { logo?: AcquiredImage; footer?: string }

function placeLogo(slide: any, img: AcquiredImage, x: number, y: number, hIn: number): void {
  const data = `data:${img.mimeType};base64,${img.buffer.toString("base64")}`;
  const ratio = img.width > 0 && img.height > 0 ? img.width / img.height : 3;
  slide.addImage({ data, x, y, w: hIn * ratio, h: hIn, altText: "Logo" });
}

export interface SlideRenderReport {
  /** True when the spec asked for an image AND it made it onto the slide. */
  imagePlaced: boolean;
  /** Loud image degradations (fallback used / image dropped) — the calling
   *  tool must surface these in its result text. */
  notes: string[];
}

/** Render one slide. Async because an inline image may need fetching. */
export async function applySlide(pptx: any, spec: SlideSpec, t: OfficeTheme, brand: SlideBrand = {}): Promise<SlideRenderReport> {
  const slide = pptx.addSlide();
  const layout = spec.layout ?? "content";
  // Brand footer (user's company) on every slide — opt-in, empty by default.
  if (brand.footer) slide.addText(brand.footer, { x: 0.4, y: SLIDE_H - 0.44, w: SLIDE_W - 2, h: 0.3, fontSize: 9, fontFace: t.fonts.body, color: t.colors.muted });
  // Sanitize all text sinks — no HTML tags / entities / leftover markdown
  // markers leak onto a slide.
  const title = spec.title != null ? toPlainText(spec.title) : "";
  const body = spec.body != null ? toPlainText(spec.body) : "";
  const bullets = (spec.bullets ?? []).map(toPlainText).filter(Boolean);
  const notes = spec.notes != null ? cleanText(spec.notes) : "";

  if (layout === "title") {
    if (brand.logo) placeLogo(slide, brand.logo, 0.7, 0.6, 0.6);
    slide.addText(title, { x: 0.7, y: 2.7, w: SLIDE_W - 1.4, h: 1.5, fontSize: t.ppt.titleSlideSize, fontFace: t.fonts.heading, color: t.colors.heading, bold: true });
    accentBar(slide, t, 0.72, 4.2, 2.4);
    if (body) slide.addText(body, { x: 0.7, y: 4.45, w: SLIDE_W - 1.4, h: 1, fontSize: t.ppt.subtitleSize, fontFace: t.fonts.body, color: t.colors.muted });
    if (notes) slide.addNotes(notes);
    return { imagePlaced: false, notes: [] };
  }
  if (layout === "section") {
    slide.addText(title, { x: 0.7, y: 3.0, w: SLIDE_W - 1.4, h: 1.5, fontSize: t.ppt.sectionSize, fontFace: t.fonts.heading, color: t.colors.accent, bold: true, align: "center" });
    accentBar(slide, t, SLIDE_W / 2 - 1.1, 4.55, 2.2);
    if (notes) slide.addNotes(notes);
    return { imagePlaced: false, notes: [] };
  }

  // content / blank — may carry a chart and/or image alongside text.
  const chart = isValidChart(spec.chart) ? spec.chart : undefined;
  const imageNotes: string[] = [];
  let img: AcquiredImage | undefined;
  if (spec.image) {
    try {
      const r = await acquireImages([spec.image]);
      img = r.images[0];
      imageNotes.push(...r.notes);
    } catch (e) {
      // A dead URL degrades to a text-only slide with a loud note; real
      // caller errors (traversal, missing local file) still fail the deck.
      if (!(e instanceof AllImagesFailedError)) throw e;
      imageNotes.push(...e.failures.map((f) => `slide ${title ? `"${title}"` : "(untitled)"}: ${f}`));
    }
  }
  const hasVisual = !!chart || !!img;
  const hasText = !!body || bullets.length > 0;

  let top = 0.6;
  if (layout !== "blank" && title) {
    slide.addText(title, { x: 0.6, y: 0.4, w: SLIDE_W - 1.2, h: 0.8, fontSize: t.ppt.titleSize, fontFace: t.fonts.heading, color: t.colors.heading, bold: true });
    accentBar(slide, t, 0.62, 1.18, 1.6);
    top = 1.5;
  }

  // Split the body: text on the left half when a visual shares the slide,
  // full width otherwise.
  const textW = hasVisual && hasText ? 5.9 : SLIDE_W - 1.2;
  if (body) slide.addText(body, { x: 0.6, y: top, w: textW, h: 1.4, fontSize: t.ppt.bodySize, fontFace: t.fonts.body, color: t.colors.body });
  if (bullets.length) {
    const items = bullets.map((b) => ({ text: b, options: { fontSize: t.ppt.bulletSize, fontFace: t.fonts.body, color: t.colors.body, bullet: { indent: 18 } } }));
    slide.addText(items, { x: 0.7, y: body ? top + 1.6 : top, w: textW, h: 4, lineSpacingMultiple: 1.3 });
  }

  if (hasVisual) {
    const box = hasText
      ? { x: 6.9, y: top, w: 5.9, h: SLIDE_H - top - 0.6 }
      : { x: 1.0, y: top, w: SLIDE_W - 2.0, h: SLIDE_H - top - 0.6 };
    if (chart) renderChart(slide, t, chart, box);
    else if (img) placeImage(slide, img, box);
  }

  if (notes) slide.addNotes(notes);
  // chart wins the visual box, so an acquired image only counts as placed
  // when no chart shares the slide.
  return { imagePlaced: !!img && !chart, notes: imageNotes };
}

/** Append each top-level acquired image on its own centered slide w/ caption. */
export function appendImageSlides(pptx: any, images: AcquiredImage[], t: OfficeTheme): void {
  for (const img of images) {
    const slide = pptx.addSlide();
    placeImage(slide, img, { x: 0.5, y: 0.5, w: SLIDE_W - 1, h: SLIDE_H - 1.4 });
    if (img.caption) {
      slide.addText(cleanText(img.caption), { x: 0.5, y: SLIDE_H - 0.8, w: SLIDE_W - 1, h: 0.6, fontSize: t.ppt.subtitleSize, fontFace: t.fonts.body, color: t.colors.muted, align: "center", italic: true });
    }
  }
}
