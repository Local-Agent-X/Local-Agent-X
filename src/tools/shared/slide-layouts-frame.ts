/**
 * The slides that frame a deck and carry one idea each: cover, section,
 * closing, statement, quote, and the full-bleed photo. Dark or colored
 * grounds, large type, little text. The body slides are in
 * slide-layouts-body.ts.
 */
import type { SlideSpec } from "./pptx-render.js";
import { SLIDE_H, SLIDE_W, containBox, cropToBox, paragraphsOf, rectEl, textEl, type SlidePlan } from "./slide-plan.js";
import { MARGIN, chrome, logo, type LayoutCtx } from "./slide-layout-kit.js";

/** Split a cover's body: the first paragraph is the tagline, what follows a
 *  blank line (or the remaining lines) is the contact block. */
function splitCoverBody(body: string): { tagline: string[]; contact: string[] } {
  const blocks = body.split(/\n\s*\n/).map(paragraphsOf).filter((b) => b.length);
  if (blocks.length > 1) return { tagline: blocks[0], contact: blocks.slice(1).flat() };
  const lines = blocks[0] ?? [];
  return { tagline: lines.slice(0, 1), contact: lines.slice(1) };
}

/** Cover: dark ground, a panel on the right (the slide's image, or the
 *  accent), the title large with a highlight rule, tagline, contact at the foot. */
export async function coverLayout(ctx: LayoutCtx, s: SlideSpec): Promise<SlidePlan> {
  const { p, t, m } = ctx;
  const plan: SlidePlan = { layout: "title", background: p.dark, elements: [] };
  const panelX = 8.75;
  const panel = { x: panelX, y: 0, w: SLIDE_W - panelX, h: SLIDE_H };
  if (ctx.image) plan.elements.push({ kind: "image", box: panel, image: await cropToBox(ctx.image, panel), alt: ctx.image.alt ?? "Cover image" });
  else plan.elements.push(rectEl(panel, p.accent));
  plan.elements.push(rectEl({ x: panelX, y: 0, w: 0.09, h: SLIDE_H }, p.highlight));
  logo(ctx, plan, MARGIN, 0.6, 0.55);
  const w = panelX - MARGIN - 0.6;
  const { tagline, contact } = splitCoverBody(s.body ?? "");
  plan.elements.push(textEl(m, { x: MARGIN, y: 1.3, w, h: 2.9 }, [s.title ?? ""], {
    font: t.fonts.heading, color: p.onDark, size: 60, minSize: 30, bold: true, valign: "bottom", lineSpacing: 0.95, role: "cover title",
  }));
  plan.elements.push(rectEl({ x: MARGIN + 0.02, y: 4.4, w: 1.3, h: 0.08 }, p.highlight));
  if (tagline.length) {
    plan.elements.push(textEl(m, { x: MARGIN, y: 4.7, w, h: 1.2 }, tagline, {
      font: t.fonts.body, color: p.onDark, size: 22, minSize: 14, role: "tagline",
    }));
  }
  if (contact.length) {
    plan.elements.push(textEl(m, { x: MARGIN, y: 6.0, w, h: 1.0 }, contact, {
      font: t.fonts.body, color: p.onDarkMuted, size: 13, minSize: 10, valign: "bottom", paraGap: 0.1, role: "contact",
    }));
  }
  return plan;
}

/** Section divider: dark ground, a numbered kicker, the title large. */
export function sectionLayout(ctx: LayoutCtx, s: SlideSpec): SlidePlan {
  const { p, t, m } = ctx;
  const plan: SlidePlan = { layout: "section", background: p.dark, elements: [] };
  plan.elements.push(rectEl({ x: MARGIN, y: 2.25, w: 0.9, h: 0.07 }, p.highlight));
  plan.elements.push(textEl(m, { x: MARGIN, y: 2.45, w: 3, h: 0.6 }, [String(ctx.sectionNo).padStart(2, "0")], {
    font: t.fonts.heading, color: p.highlight, size: 22, minSize: 16, bold: true, role: "section number",
  }));
  plan.elements.push(textEl(m, { x: MARGIN, y: 3.05, w: SLIDE_W - 2 * MARGIN - 1, h: 1.9 }, [s.title ?? ""], {
    font: t.fonts.heading, color: p.onDark, size: 44, minSize: 26, bold: true, role: "section title",
  }));
  const body = paragraphsOf(s.body);
  if (body.length) {
    plan.elements.push(textEl(m, { x: MARGIN, y: 5.0, w: SLIDE_W - 2 * MARGIN - 2, h: 1.4 }, body, {
      font: t.fonts.body, color: p.onDarkMuted, size: 20, minSize: 13, role: "section text",
    }));
  }
  chrome(ctx, plan, true);
  return plan;
}

/** Closing / ask: dark ground, centered title over a highlight rule, the ask
 *  or contact under it. */
export function closingLayout(ctx: LayoutCtx, s: SlideSpec): SlidePlan {
  const { p, t, m } = ctx;
  const plan: SlidePlan = { layout: "closing", background: p.dark, elements: [] };
  plan.elements.push(textEl(m, { x: 1, y: 1.5, w: SLIDE_W - 2, h: 2.3 }, [s.title ?? ""], {
    font: t.fonts.heading, color: p.onDark, size: 48, minSize: 28, bold: true, align: "center", valign: "bottom", role: "closing title",
  }));
  plan.elements.push(rectEl({ x: SLIDE_W / 2 - 0.65, y: 4.0, w: 1.3, h: 0.08 }, p.highlight));
  const body = [...paragraphsOf(s.body), ...(s.bullets ?? [])];
  if (body.length) {
    plan.elements.push(textEl(m, { x: 1.5, y: 4.35, w: SLIDE_W - 3, h: 2.4 }, body, {
      font: t.fonts.body, color: p.onDarkMuted, size: 22, minSize: 13, align: "center", paraGap: 0.25, role: "closing text",
    }));
  }
  logo(ctx, plan, MARGIN, 0.6, 0.5);
  chrome(ctx, plan, true);
  return plan;
}

/** Statement: one sentence on the accent ground, with the title as a kicker. */
export function statementLayout(ctx: LayoutCtx, s: SlideSpec): SlidePlan {
  const { p, t, m } = ctx;
  const plan: SlidePlan = { layout: "statement", background: p.accent, elements: [] };
  const words = paragraphsOf(s.body).length ? paragraphsOf(s.body) : [s.title ?? ""];
  if (s.title && paragraphsOf(s.body).length) {
    plan.elements.push(textEl(m, { x: 1.0, y: 1.2, w: SLIDE_W - 2, h: 0.55 }, [s.title.toUpperCase()], {
      font: t.fonts.heading, color: p.highlight, size: 16, minSize: 12, bold: true, role: "kicker",
    }));
  }
  plan.elements.push(textEl(m, { x: 1.0, y: 1.9, w: SLIDE_W - 2.4, h: 4.3 }, words, {
    font: t.fonts.heading, color: p.onDark, size: 44, minSize: 24, bold: true, valign: "middle", lineSpacing: 1.05, role: "statement",
  }));
  chrome(ctx, plan, true);
  return plan;
}

/** Quote: tinted ground, a large highlight quotation mark, the words in
 *  italic and who said them. */
export function quoteLayout(ctx: LayoutCtx, s: SlideSpec): SlidePlan {
  const { p, t, m } = ctx;
  // A white ground with the accent: the tint this had first left the grey
  // attribution and the gold mark under readable contrast.
  const plan: SlidePlan = { layout: "quote", background: p.light, elements: [] };
  plan.elements.push(rectEl({ x: 0, y: 0, w: 0.22, h: SLIDE_H }, p.accent));
  plan.elements.push(textEl(m, { x: 1.0, y: 0.4, w: 1.8, h: 2.4 }, ["“"], {
    font: t.fonts.heading, color: p.accent, size: 140, minSize: 90, bold: true, role: "quote mark",
  }));
  const quote = paragraphsOf(s.body).length ? paragraphsOf(s.body) : [s.title ?? ""];
  plan.elements.push(textEl(m, { x: 1.7, y: 1.9, w: SLIDE_W - 3.4, h: 3.5 }, quote, {
    font: t.fonts.heading, color: p.ink, size: 40, minSize: 20, italic: true, valign: "middle", role: "quote",
  }));
  const who = s.attribution ?? (paragraphsOf(s.body).length ? s.title : undefined);
  if (who) {
    plan.elements.push(textEl(m, { x: 1.7, y: 5.6, w: SLIDE_W - 3.4, h: 0.6 }, [`— ${who}`], {
      font: t.fonts.body, color: p.muted, size: 20, minSize: 12, role: "attribution",
    }));
  }
  chrome(ctx, plan, false);
  return plan;
}

/** Full-bleed photo with the title on a dark band; without an image, a
 *  statement says the same words. */
export async function imageLayout(ctx: LayoutCtx, s: SlideSpec): Promise<SlidePlan> {
  if (!ctx.image) return statementLayout(ctx, s);
  const { p, t, m } = ctx;
  const plan: SlidePlan = { layout: "image", background: p.dark, elements: [] };
  const full = { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H };
  plan.elements.push({ kind: "image", box: full, image: await cropToBox(ctx.image, full), alt: ctx.image.alt ?? s.title ?? "Photo" });
  const text = [s.title, ...paragraphsOf(s.body)].filter(Boolean) as string[];
  if (text.length) {
    plan.elements.push(rectEl({ x: 0, y: 5.05, w: SLIDE_W, h: SLIDE_H - 5.05 }, p.dark, 15));
    if (s.title) {
      plan.elements.push(textEl(m, { x: MARGIN, y: 5.3, w: SLIDE_W - 2 * MARGIN, h: 0.95 }, [s.title], {
        font: t.fonts.heading, color: p.onDark, size: 34, minSize: 20, bold: true, role: "photo title",
      }));
    }
    const body = paragraphsOf(s.body);
    if (body.length) {
      plan.elements.push(textEl(m, { x: MARGIN, y: 6.25, w: SLIDE_W - 2 * MARGIN - 1, h: 0.75 }, body, {
        font: t.fonts.body, color: p.onDarkMuted, size: 18, minSize: 12, role: "photo caption",
      }));
    }
  }
  chrome(ctx, plan, true);
  return plan;
}

/** An appended photo (the deck's `images`): dark ground, the whole picture,
 *  its caption under it. */
export function photoLayout(ctx: LayoutCtx, caption: string | undefined): SlidePlan {
  const { p, t, m } = ctx;
  const plan: SlidePlan = { layout: "photo", background: p.dark, elements: [] };
  const area = { x: 0.6, y: 0.5, w: SLIDE_W - 1.2, h: caption ? SLIDE_H - 1.6 : SLIDE_H - 1.0 };
  if (ctx.image) plan.elements.push({ kind: "image", box: containBox(ctx.image, area), image: ctx.image, alt: ctx.image.alt ?? caption ?? "Photo" });
  if (caption) {
    plan.elements.push(textEl(m, { x: 0.6, y: SLIDE_H - 0.95, w: SLIDE_W - 1.2, h: 0.55 }, [caption], {
      font: t.fonts.body, color: p.onDarkMuted, size: 16, minSize: 11, italic: true, align: "center", role: "caption",
    }));
  }
  chrome(ctx, plan, true);
  return plan;
}
