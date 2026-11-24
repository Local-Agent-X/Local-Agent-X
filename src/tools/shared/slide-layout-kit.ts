/**
 * What every slide layout shares: the context it is laid out in, the slide
 * chrome (number, brand footer, logo) and the title block of a content slide.
 * The layouts themselves are in slide-layouts-frame.ts (cover, section,
 * closing, statement, quote, photo) and slide-layouts-body.ts (content,
 * stats, columns, timeline).
 */
import type { AcquiredImage } from "./image-acquire.js";
import type { ChartSpec } from "./office-chart.js";
import type { OfficeTheme } from "./office-theme.js";
import { SLIDE_H, SLIDE_W, rectEl, textEl, type PlanElement, type SlidePalette, type SlidePlan } from "./slide-plan.js";
import type { Measurer } from "./slide-text-fit.js";

export interface SlideBrand { logo?: AcquiredImage; footer?: string }

/** Layout input beyond the spec: the slide's place in the deck and what the
 *  renderer already fetched for it. */
export interface LayoutCtx {
  m: Measurer;
  t: OfficeTheme;
  p: SlidePalette;
  brand: SlideBrand;
  /** 1-based position in the deck; 0 when the slide stands alone. */
  number: number;
  /** 1-based count of section slides so far, for a section's kicker. */
  sectionNo: number;
  /** Put the visual on the left: consecutive visual slides alternate sides. */
  mirror: boolean;
  image?: AcquiredImage;
  chart?: ChartSpec;
}

export const MARGIN = 0.7;

/** Slide number and brand footer, in the ground's own colors. The cover
 *  carries neither. `side` keeps them off a full-bleed visual. */
export function chrome(ctx: LayoutCtx, plan: SlidePlan, dark: boolean, side: "left" | "right" | "full" = "full"): void {
  const color = dark ? ctx.p.onDarkMuted : ctx.p.muted;
  const font = ctx.t.fonts.body;
  const xMax = side === "left" ? SLIDE_W / 2 - 0.4 : SLIDE_W - MARGIN;
  const xMin = side === "right" ? SLIDE_W / 2 + 0.4 : MARGIN;
  if (ctx.number > 0) {
    plan.elements.push(textEl(ctx.m, { x: xMax - 0.8, y: SLIDE_H - 0.55, w: 0.8, h: 0.3 }, [String(ctx.number)], {
      font, color, size: 10, minSize: 9, align: "right", role: "slide number",
    }));
  }
  if (ctx.brand.footer) {
    plan.elements.push(textEl(ctx.m, { x: xMin, y: SLIDE_H - 0.55, w: Math.max(1, xMax - xMin - 1.0), h: 0.3 }, [ctx.brand.footer], {
      font, color, size: 9, minSize: 8, role: "footer",
    }));
  }
}

/** A content slide's title and the accent rule under it. Returns where the
 *  body may start. Empty title: nothing drawn, body starts high. */
export function titleBlock(ctx: LayoutCtx, plan: SlidePlan, title: string, x = MARGIN, w = SLIDE_W - 2 * MARGIN): number {
  if (!title) return 0.7;
  plan.elements.push(textEl(ctx.m, { x, y: 0.4, w, h: 1.0 }, [title], {
    font: ctx.t.fonts.heading, color: ctx.p.ink, size: 34, minSize: 22, bold: true, valign: "bottom", role: "title",
  }));
  plan.elements.push(rectEl({ x: x + 0.02, y: 1.48, w: 1.1, h: 0.06 }, ctx.p.accent));
  return 1.8;
}

/** Bullets under optional body text, fitted to the rest of the box. */
export function bodyAndBullets(ctx: LayoutCtx, box: { x: number; y: number; w: number; h: number }, body: string[], bullets: string[], color: string): PlanElement[] {
  const out: PlanElement[] = [];
  let y = box.y;
  if (body.length) {
    const maxH = bullets.length ? Math.min(box.h * 0.4, 2.2) : box.h;
    const el = textEl(ctx.m, { x: box.x, y, w: box.w, h: maxH }, body, {
      font: ctx.t.fonts.body, color, size: 24, minSize: 13, role: "body",
    });
    // The bullets start under the body as it actually wrapped.
    if (bullets.length) el.box = { ...el.box, h: Math.min(maxH, el.fit.height + 0.05) };
    out.push(el);
    y += el.box.h + (bullets.length ? 0.3 : 0);
  }
  if (bullets.length) {
    out.push(textEl(ctx.m, { x: box.x, y, w: box.w, h: box.y + box.h - y }, bullets, {
      font: ctx.t.fonts.body, color, size: 24, minSize: 13, bullets: true, role: "bullets",
    }));
  }
  return out;
}

/** The logo, at the top left of the slides that carry it. */
export function logo(ctx: LayoutCtx, plan: SlidePlan, x: number, y: number, h: number): void {
  const img = ctx.brand.logo;
  if (!img) return;
  const ratio = img.width > 0 && img.height > 0 ? img.width / img.height : 3;
  plan.elements.push({ kind: "image", box: { x, y, w: h * ratio, h }, image: img, alt: "Logo" });
}
