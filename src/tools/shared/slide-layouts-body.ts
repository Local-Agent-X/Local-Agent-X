/**
 * The slides that carry a deck's substance: content (text with a photo or
 * chart beside it), stats, columns, and timeline. Light ground, a title block,
 * the body laid out for what it is. The framing slides are in
 * slide-layouts-frame.ts.
 */
import type { SlideSpec } from "./pptx-render.js";
import { SLIDE_H, SLIDE_W, cropToBox, paragraphsOf, rectEl, textEl, type Box, type SlidePlan } from "./slide-plan.js";
import { MARGIN, bodyAndBullets, chrome, titleBlock, type LayoutCtx } from "./slide-layout-kit.js";

const BOTTOM = SLIDE_H - 0.75;

/** Text with an optional visual. A photo fills its half of the slide edge to
 *  edge; a chart sits in a framed box. `ctx.mirror` puts the visual on the
 *  left, so consecutive visual slides alternate. */
export async function contentLayout(ctx: LayoutCtx, s: SlideSpec, layout: "content" | "blank"): Promise<SlidePlan> {
  const { p } = ctx;
  const plan: SlidePlan = { layout, background: p.light, elements: [] };
  const body = paragraphsOf(s.body);
  const bullets = (s.bullets ?? []).filter(Boolean);
  const hasText = body.length > 0 || bullets.length > 0;
  const visual = ctx.chart ? "chart" : ctx.image ? "image" : null;
  const title = layout === "blank" ? "" : s.title ?? "";

  if (!visual) {
    const top = titleBlock(ctx, plan, title);
    plan.elements.push(...bodyAndBullets(ctx, { x: MARGIN, y: top, w: SLIDE_W - 2 * MARGIN, h: BOTTOM - top }, body, bullets, p.body));
    chrome(ctx, plan, false);
    return plan;
  }
  if (!hasText && visual === "image") {
    // A picture with a title only: the picture is the slide.
    const top = titleBlock(ctx, plan, title);
    const box: Box = { x: MARGIN, y: top, w: SLIDE_W - 2 * MARGIN, h: BOTTOM - top };
    plan.elements.push({ kind: "image", box, image: await cropToBox(ctx.image!, box), alt: ctx.image!.alt ?? title });
    chrome(ctx, plan, false);
    return plan;
  }

  const half = SLIDE_W / 2;
  const textX = ctx.mirror ? half + 0.45 : MARGIN;
  const textW = half - MARGIN - 0.45;
  const top = titleBlock(ctx, plan, title, textX, hasText ? textW : SLIDE_W - 2 * MARGIN);
  if (hasText) plan.elements.push(...bodyAndBullets(ctx, { x: textX, y: top, w: textW, h: BOTTOM - top }, body, bullets, p.body));

  if (visual === "image") {
    const panel: Box = { x: ctx.mirror ? 0 : half + 0.15, y: 0, w: half - 0.15, h: SLIDE_H };
    plan.elements.push({ kind: "image", box: panel, image: await cropToBox(ctx.image!, panel), alt: ctx.image!.alt ?? title });
    chrome(ctx, plan, false, ctx.mirror ? "right" : "left");
  } else {
    const area: Box = hasText
      ? { x: ctx.mirror ? MARGIN : half + 0.2, y: top, w: half - MARGIN - 0.2, h: BOTTOM - top }
      : { x: MARGIN + 0.4, y: top, w: SLIDE_W - 2 * MARGIN - 0.8, h: BOTTOM - top };
    plan.elements.push(rectEl(area, p.band));
    plan.elements.push({ kind: "chart", box: { x: area.x + 0.2, y: area.y + 0.2, w: area.w - 0.4, h: area.h - 0.4 }, chart: ctx.chart! });
    chrome(ctx, plan, false);
  }
  return plan;
}

/** Big numbers: up to four cards, each a value in the accent and what it
 *  measures. A body line becomes the source note at the foot. */
export function statsLayout(ctx: LayoutCtx, s: SlideSpec): SlidePlan {
  const { p, t, m } = ctx;
  const plan: SlidePlan = { layout: "stats", background: p.light, elements: [] };
  const top = titleBlock(ctx, plan, s.title ?? "");
  const stats = (s.stats ?? []).slice(0, 4);
  const n = Math.max(1, stats.length);
  const gap = 0.3;
  const areaW = SLIDE_W - 2 * MARGIN;
  const cardW = (areaW - gap * (n - 1)) / n;
  const cardY = top + 0.3, cardH = 3.6;
  stats.forEach((st, i) => {
    const x = MARGIN + i * (cardW + gap);
    plan.elements.push(rectEl({ x, y: cardY, w: cardW, h: cardH }, p.band));
    plan.elements.push(rectEl({ x, y: cardY, w: cardW, h: 0.07 }, p.accent));
    plan.elements.push(textEl(m, { x: x + 0.35, y: cardY + 0.4, w: cardW - 0.7, h: 1.6 }, [st.value], {
      font: t.fonts.heading, color: p.accent, size: n > 2 ? 72 : 96, minSize: 28, bold: true, valign: "bottom", role: "stat value",
    }));
    plan.elements.push(textEl(m, { x: x + 0.35, y: cardY + 2.15, w: cardW - 0.7, h: cardH - 2.4 }, [st.label], {
      font: t.fonts.body, color: p.body, size: 22, minSize: 12, role: "stat label",
    }));
  });
  const note = paragraphsOf(s.body);
  if (note.length) {
    plan.elements.push(textEl(m, { x: MARGIN, y: cardY + cardH + 0.25, w: areaW, h: BOTTOM - (cardY + cardH + 0.25) }, note, {
      font: t.fonts.body, color: p.muted, size: 14, minSize: 10, role: "stat note",
    }));
  }
  chrome(ctx, plan, false);
  return plan;
}

/** Two or three columns, each a card with an accent edge, a heading and
 *  its points: comparisons, options, before/after. */
export function columnsLayout(ctx: LayoutCtx, s: SlideSpec): SlidePlan {
  const { p, t, m } = ctx;
  const plan: SlidePlan = { layout: "columns", background: p.light, elements: [] };
  const top = titleBlock(ctx, plan, s.title ?? "");
  const cols = (s.columns ?? []).slice(0, 3);
  const n = Math.max(1, cols.length);
  const gap = 0.35;
  const colW = (SLIDE_W - 2 * MARGIN - gap * (n - 1)) / n;
  const y = top + 0.15, h = BOTTOM - y;
  cols.forEach((c, i) => {
    const x = MARGIN + i * (colW + gap);
    plan.elements.push(rectEl({ x, y, w: colW, h }, p.band));
    plan.elements.push(rectEl({ x, y, w: colW, h: 0.08 }, i === 0 ? p.accent : i === 1 ? p.highlight : p.ink));
    plan.elements.push(textEl(m, { x: x + 0.3, y: y + 0.3, w: colW - 0.6, h: 0.8 }, [c.heading], {
      font: t.fonts.heading, color: p.ink, size: 26, minSize: 15, bold: true, valign: "bottom", role: "column heading",
    }));
    const pts = [...paragraphsOf(c.body), ...(c.bullets ?? [])];
    if (pts.length) {
      plan.elements.push(textEl(m, { x: x + 0.3, y: y + 1.25, w: colW - 0.6, h: h - 1.5 }, pts, {
        font: t.fonts.body, color: p.body, size: 22, minSize: 12, bullets: !!c.bullets?.length && !c.body, role: "column text",
      }));
    }
  });
  chrome(ctx, plan, false);
  return plan;
}

/** Steps along a line: a roadmap, a process, a history. Up to six. */
export function timelineLayout(ctx: LayoutCtx, s: SlideSpec): SlidePlan {
  const { p, t, m } = ctx;
  const plan: SlidePlan = { layout: "timeline", background: p.light, elements: [] };
  const top = titleBlock(ctx, plan, s.title ?? "");
  const steps = (s.steps ?? []).slice(0, 6);
  const n = Math.max(1, steps.length);
  const lineY = top + 1.25;
  const slot = (SLIDE_W - 2 * MARGIN) / n;
  plan.elements.push(rectEl({ x: MARGIN + slot / 2, y: lineY - 0.025, w: slot * (n - 1), h: 0.05 }, p.accent));
  steps.forEach((st, i) => {
    const cx = MARGIN + slot * i + slot / 2;
    const d = 0.38;
    plan.elements.push({ kind: "ellipse", box: { x: cx - d / 2, y: lineY - d / 2, w: d, h: d }, color: i === n - 1 ? p.highlight : p.accent });
    plan.elements.push(textEl(m, { x: cx - slot / 2 + 0.1, y: lineY + 0.4, w: slot - 0.2, h: 0.85 }, [st.label], {
      font: t.fonts.heading, color: p.ink, size: 26, minSize: 13, bold: true, align: "center", role: "step label",
    }));
    if (st.text) {
      plan.elements.push(textEl(m, { x: cx - slot / 2 + 0.1, y: lineY + 1.3, w: slot - 0.2, h: BOTTOM - lineY - 1.3 }, [st.text], {
        font: t.fonts.body, color: p.body, size: 19, minSize: 11, align: "center", role: "step text",
      }));
    }
  });
  const body = paragraphsOf(s.body);
  if (body.length) {
    plan.elements.push(textEl(m, { x: MARGIN, y: top, w: SLIDE_W - 2 * MARGIN, h: 0.7 }, body, {
      font: t.fonts.body, color: p.muted, size: 16, minSize: 11, role: "timeline intro",
    }));
  }
  chrome(ctx, plan, false);
  return plan;
}
