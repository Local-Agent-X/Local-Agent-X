/**
 * What is wrong with a planned deck, found from the plans themselves: text
 * that does not fit its box even at its smallest size, text too faint for its
 * ground, slides too dense to read when projected, and a deck that repeats
 * one layout. The agent gets these with the rendered slides, before it tells
 * the user the deck is done.
 */
import type { Box, SlidePlan, TextElement } from "./slide-plan.js";

/** WCAG relative luminance of a 6-digit hex color. */
function luminance(hexColor: string): number {
  const h = hexColor.replace(/^#/, "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const contains = (outer: Box, x: number, y: number) =>
  x >= outer.x && x <= outer.x + outer.w && y >= outer.y && y <= outer.y + outer.h;

/** The color under a text element's center: the last solid shape drawn
 *  beneath it, else the slide's ground. A photo underneath gives no single
 *  color, so it returns null and contrast is not judged there. */
function groundUnder(plan: SlidePlan, el: TextElement): string | null {
  const cx = el.box.x + el.box.w / 2, cy = el.box.y + el.box.h / 2;
  let ground: string | null = plan.background;
  for (const other of plan.elements) {
    if (other === el) break;
    if (!contains(other.box, cx, cy)) continue;
    if (other.kind === "rect" || other.kind === "ellipse") {
      if (other.kind === "rect" && other.transparency && other.transparency > 30) continue;
      ground = other.color;
    } else if (other.kind === "image" || other.kind === "chart") ground = null;
  }
  return ground;
}

const snippet = (el: TextElement) => {
  const s = el.paragraphs.join(" ");
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
};

/** Over this many words a slide is a document, not something to project. */
export const MAX_WORDS_PER_SLIDE = 75;
export const MAX_BULLETS = 6;

function slideFindings(plan: SlidePlan, n: number): string[] {
  const out: string[] = [];
  let words = 0;
  for (const el of plan.elements) {
    if (el.kind !== "text") continue;
    if (el.role !== "slide number" && el.role !== "footer") words += el.paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
    if (el.fit.overflow) out.push(`slide ${n}: the ${el.role} ("${snippet(el)}") does not fit its space even at ${el.fit.size}pt; shorten it or split the slide`);
    if (el.bullets && el.paragraphs.length > MAX_BULLETS) out.push(`slide ${n}: ${el.paragraphs.length} bullets; keep it to ${MAX_BULLETS} or fewer, or split the slide`);
    const ground = groundUnder(plan, el);
    if (ground) {
      const ratio = contrastRatio(el.color, ground);
      const large = el.fit.size >= 24 || (el.bold && el.fit.size >= 19);
      if (ratio < (large ? 3 : 4.5)) out.push(`slide ${n}: the ${el.role} is hard to read (contrast ${ratio.toFixed(1)}:1 on its background)`);
    }
  }
  if (words > MAX_WORDS_PER_SLIDE) out.push(`slide ${n}: ${words} words is too much to read on a projected slide; cut it down or move the detail to speaker notes`);
  return out;
}

/** Runs of one layout the audience will feel as sameness. */
function repetitionFindings(plans: SlidePlan[]): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 1; i <= plans.length; i++) {
    if (i < plans.length && plans[i].layout === plans[start].layout) continue;
    const run = i - start, layout = plans[start].layout;
    const tooLong = layout === "content" ? run >= 3 : run >= 2 && layout !== "photo";
    if (tooLong) out.push(`slides ${start + 1}-${i}: ${run} "${layout}" slides in a row; vary them (stats for numbers, columns for comparisons, timeline for steps, quote, statement, image)`);
    start = i;
  }
  return out;
}

/** Every finding for a deck, in slide order. */
export function checkDeck(plans: SlidePlan[]): string[] {
  return [...plans.flatMap((p, i) => slideFindings(p, i + 1)), ...repetitionFindings(plans)];
}
