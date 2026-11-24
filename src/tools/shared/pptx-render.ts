/**
 * PowerPoint deck rendering, shared by every presentation action: a deck's
 * slide specs become slide plans (slide-plan.ts), which are written to the
 * .pptx (slide-emit-pptx.ts) and drawn for the agent to look at
 * (slide-raster.ts, deck-preview.ts).
 *
 * The layout vocabulary is what a deck is made of: a cover, section dividers,
 * content slides with a photo or chart beside the text, big stats, columns,
 * a timeline, a quote, a one-line statement, a full-bleed photo, and a
 * closing ask. Before 2026-11-23 there were four layouts on a white page, and
 * every deck looked the same whatever it was for.
 */
import { acquireImages, AllImagesFailedError, type AcquiredImage, type ImageSpec } from "./image-acquire.js";
import type { OfficeTheme } from "./office-theme.js";
import { cleanText, toPlainText } from "./office-md.js";
import { isValidChart, type ChartSpec } from "./office-chart.js";
import { slidePalette, type SlidePlan } from "./slide-plan.js";
import { getMeasurer } from "./slide-text-fit.js";
import type { LayoutCtx, SlideBrand } from "./slide-layout-kit.js";
import { closingLayout, coverLayout, imageLayout, photoLayout, quoteLayout, sectionLayout, statementLayout } from "./slide-layouts-frame.js";
import { columnsLayout, contentLayout, statsLayout, timelineLayout } from "./slide-layouts-body.js";
import { emitSlide } from "./slide-emit-pptx.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const SLIDE_LAYOUTS = [
  "title", "section", "content", "stats", "columns", "timeline", "quote", "statement", "image", "closing", "blank",
] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export interface SlideSpec {
  title?: string;
  body?: string;
  bullets?: string[];
  notes?: string;
  layout?: SlideLayout;
  /** Native chart rendered on this slide. */
  chart?: ChartSpec;
  /** Photo for this slide: beside the text, the cover's panel, or full bleed. */
  image?: ImageSpec;
  /** stats: up to four big numbers. */
  stats?: Array<{ value: string; label: string }>;
  /** columns: two or three, each a heading and its points. */
  columns?: Array<{ heading: string; body?: string; bullets?: string[] }>;
  /** timeline: up to six steps. */
  steps?: Array<{ label: string; text?: string }>;
  /** quote: who said it (the quote itself is the body). */
  attribution?: string;
}

export interface DeckBuild {
  plans: SlidePlan[];
  /** Slides that asked for an image and got one. */
  imagesPlaced: number;
  /** Loud image degradations (fallback used / image dropped), for the result. */
  notes: string[];
}

/** The layout a spec gets: the one it names, or the one its content implies. */
export function resolveLayout(s: SlideSpec): SlideLayout {
  if (s.layout && (SLIDE_LAYOUTS as readonly string[]).includes(s.layout)) return s.layout;
  if (s.stats?.length) return "stats";
  if (s.columns?.length) return "columns";
  if (s.steps?.length) return "timeline";
  return "content";
}

/** Text the model wrote, made safe for a slide: no HTML, entities or markdown. */
function sanitize(s: SlideSpec): SlideSpec {
  const plain = (v?: string) => (v == null ? undefined : toPlainText(v));
  return {
    ...s,
    title: plain(s.title), body: plain(s.body), attribution: plain(s.attribution),
    bullets: (s.bullets ?? []).map(toPlainText).filter(Boolean),
    notes: s.notes != null ? cleanText(s.notes) : undefined,
    stats: s.stats?.map((st) => ({ value: toPlainText(String(st.value)), label: toPlainText(String(st.label ?? "")) })),
    columns: s.columns?.map((c) => ({ heading: toPlainText(String(c.heading ?? "")), body: plain(c.body), bullets: c.bullets?.map(toPlainText).filter(Boolean) })),
    steps: s.steps?.map((st) => ({ label: toPlainText(String(st.label ?? "")), text: plain(st.text) })),
  };
}

/** A slide's own image. A dead URL degrades to the slide without it, with a
 *  loud note; a real caller error (traversal, missing local file) throws. */
async function slideImage(s: SlideSpec, notes: string[]): Promise<AcquiredImage | undefined> {
  if (!s.image) return undefined;
  try {
    const r = await acquireImages([s.image]);
    notes.push(...r.notes);
    return r.images[0];
  } catch (e) {
    if (!(e instanceof AllImagesFailedError)) throw e;
    notes.push(...e.failures.map((f) => `slide ${s.title ? `"${s.title}"` : "(untitled)"}: ${f}`));
    return undefined;
  }
}

async function planFor(layout: SlideLayout, ctx: LayoutCtx, s: SlideSpec): Promise<SlidePlan> {
  switch (layout) {
    case "title": return coverLayout(ctx, s);
    case "section": return sectionLayout(ctx, s);
    case "closing": return closingLayout(ctx, s);
    case "statement": return statementLayout(ctx, s);
    case "quote": return quoteLayout(ctx, s);
    case "image": return imageLayout(ctx, s);
    case "stats": return s.stats?.length ? statsLayout(ctx, s) : contentLayout(ctx, s, "content");
    case "columns": return s.columns?.length ? columnsLayout(ctx, s) : contentLayout(ctx, s, "content");
    case "timeline": return s.steps?.length ? timelineLayout(ctx, s) : contentLayout(ctx, s, "content");
    case "blank": return contentLayout(ctx, s, "blank");
    default: return contentLayout(ctx, s, "content");
  }
}

/** Plan every slide of a deck (specs, then the `images` as photo slides) and
 *  write them into `pptx`. `numbered` false leaves slide numbers off (a
 *  single slide headed for another deck). */
export async function buildDeck(
  pptx: any, specs: SlideSpec[], photos: AcquiredImage[], t: OfficeTheme, brand: SlideBrand, numbered = true,
): Promise<DeckBuild> {
  const m = await getMeasurer();
  const p = slidePalette(t);
  const plans: SlidePlan[] = [];
  const notes: string[] = [];
  let imagesPlaced = 0, sectionNo = 0, visualSlides = 0;
  for (const raw of specs) {
    const s = sanitize(raw);
    const layout = resolveLayout(s);
    const chart = isValidChart(s.chart) ? s.chart : undefined;
    const image = await slideImage(s, notes);
    if (layout === "section") sectionNo++;
    const sideBySide = layout === "content" && (!!chart || !!image) && (!!s.body || !!s.bullets?.length);
    const ctx: LayoutCtx = {
      m, t, p, brand, number: numbered ? plans.length + 1 : 0, sectionNo,
      mirror: sideBySide && visualSlides++ % 2 === 1, image, chart,
    };
    const plan = await planFor(layout, ctx, s);
    if (s.notes) plan.notes = s.notes;
    // chart wins a content slide's visual box, so the image counts only when shown.
    if (image && plan.elements.some((el) => el.kind === "image" && el.image.source === image.source)) imagesPlaced++;
    plans.push(plan);
  }
  for (const img of photos) {
    plans.push(photoLayout({ m, t, p, brand, number: numbered ? plans.length + 1 : 0, sectionNo, mirror: false, image: img }, img.caption ? cleanText(img.caption) : undefined));
  }
  for (const plan of plans) emitSlide(pptx, t, plan);
  return { plans, imagesPlaced, notes };
}
