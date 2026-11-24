/**
 * Deck rendering: specs become planned slides with real grounds and a layout
 * for what each slide says, written to PowerPoint at the sizes the plan
 * chose. Before 2026-11-23 every slide was white with four layouts, and a
 * pitch deck's cover looked like a memo.
 */
import { describe, expect, it } from "vitest";
import { buildDeck, resolveLayout, type SlideSpec } from "./pptx-render.js";
import { resolveOfficeTheme } from "./office-theme.js";
import { SLIDE_H, SLIDE_W, slidePalette, type SlidePlan } from "./slide-plan.js";
import { getMeasurer } from "./slide-text-fit.js";
import { contentLayout } from "./slide-layouts-body.js";
import type { AcquiredImage } from "./image-acquire.js";
import type { LayoutCtx } from "./slide-layout-kit.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function fakePptx() {
  const slides: Array<{ background?: { color: string }; texts: any[]; shapes: string[]; images: number; charts: number; notes?: string }> = [];
  return {
    slides,
    addSlide() {
      const s: any = { texts: [], shapes: [], images: 0, charts: 0 };
      s.addText = (runs: any, opts: any) => s.texts.push({ runs, opts });
      s.addShape = (kind: string) => s.shapes.push(kind);
      s.addImage = () => { s.images++; };
      s.addChart = () => { s.charts++; };
      s.addNotes = (n: string) => { s.notes = n; };
      slides.push(s);
      return s;
    },
  };
}

async function photo(): Promise<AcquiredImage> {
  const sharp = (await import("sharp")).default;
  const buffer = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  return { buffer, mimeType: "image/jpeg", width: 800, height: 600, source: "test.jpg" };
}

const theme = resolveOfficeTheme();
const inBounds = (plan: SlidePlan) => plan.elements.every((el) =>
  el.box.x >= -0.001 && el.box.y >= -0.001 && el.box.x + el.box.w <= SLIDE_W + 0.001 && el.box.y + el.box.h <= SLIDE_H + 0.001);

describe("resolveLayout", () => {
  it("uses the named layout, else the one the content implies", () => {
    expect(resolveLayout({ layout: "quote" })).toBe("quote");
    expect(resolveLayout({ stats: [{ value: "1", label: "x" }] })).toBe("stats");
    expect(resolveLayout({ columns: [{ heading: "a" }] })).toBe("columns");
    expect(resolveLayout({ steps: [{ label: "a" }] })).toBe("timeline");
    expect(resolveLayout({ layout: "nonsense" as never, title: "x" })).toBe("content");
  });
});

describe("buildDeck", () => {
  const deck: SlideSpec[] = [
    { layout: "title", title: "Local Agent X", body: "Private AI that runs on your own machines\n\nPeter Manrique · Founder" },
    { layout: "statement", title: "The problem", body: "Every assistant sends your data to someone else's cloud." },
    { title: "What it does", bullets: ["Runs locally", "Any model", "Phone access"], notes: "Say it slowly" },
    { layout: "stats", title: "Market", stats: [{ value: "$11.1B", label: "2025" }, { value: "$113.7B", label: "2034" }] },
    { layout: "columns", title: "Compare", columns: [{ heading: "Cloud", bullets: ["Data leaves"] }, { heading: "Us", bullets: ["Stays local"] }] },
    { layout: "timeline", title: "Plan", steps: [{ label: "Now" }, { label: "Q2", text: "Mobile" }, { label: "Q3" }] },
    { layout: "quote", body: "Nothing leaves our computers.", attribution: "A customer" },
    { layout: "section", title: "Part two" },
    { layout: "closing", title: "Raising $1M", body: "peter@example.com" },
  ];

  it("paints the framing slides dark and the body slides light, every slide on its own ground", async () => {
    const pptx = fakePptx();
    const r = await buildDeck(pptx, deck, [], theme, {});
    const p = slidePalette(theme);
    expect(r.plans.map((pl) => pl.layout)).toEqual(["title", "statement", "content", "stats", "columns", "timeline", "quote", "section", "closing"]);
    expect(pptx.slides.map((s) => s.background?.color)).toEqual([p.dark, p.accent, p.light, p.light, p.light, p.light, p.light, p.dark, p.dark]);
    expect(pptx.slides[2].notes).toBe("Say it slowly");
  });

  it("fits every slide's text inside the slide, and writes the fitted size with autofit off", async () => {
    const pptx = fakePptx();
    const r = await buildDeck(pptx, deck, [], theme, {});
    for (const plan of r.plans) {
      expect(inBounds(plan), plan.layout).toBe(true);
      for (const el of plan.elements) if (el.kind === "text") expect(el.fit.overflow, `${plan.layout}: ${el.role}`).toBe(false);
    }
    const title = pptx.slides[0].texts.find((t) => t.runs[0].text === "Local Agent X");
    const fitted = r.plans[0].elements.find((el) => el.kind === "text" && el.paragraphs[0] === "Local Agent X") as any;
    expect(title.opts).toMatchObject({ fontSize: fitted.fit.size, fit: "none", margin: 0 });
  });

  it("numbers every slide but the cover, and leaves numbers off a slide made for another deck", async () => {
    const numbered = await buildDeck(fakePptx(), deck.slice(0, 3), [], theme, {});
    const numberOf = (pl: SlidePlan) => pl.elements.find((el) => el.kind === "text" && el.role === "slide number");
    expect(numberOf(numbered.plans[0])).toBeUndefined();
    expect((numberOf(numbered.plans[2]) as any).paragraphs).toEqual(["3"]);
    const single = await buildDeck(fakePptx(), [deck[2]], [], theme, {}, false);
    expect(numberOf(single.plans[0])).toBeUndefined();
  });

  it("appends the deck's images as photo slides", async () => {
    const r = await buildDeck(fakePptx(), [deck[2]], [await photo()], theme, {});
    expect(r.plans.map((pl) => pl.layout)).toEqual(["content", "photo"]);
  });
});

describe("content slides with a photo", () => {
  it("fill half the slide with it, on the side the deck's rhythm says", async () => {
    const m = await getMeasurer();
    const img = await photo();
    const ctx = (mirror: boolean): LayoutCtx => ({ m, t: theme, p: slidePalette(theme), brand: {}, number: 2, sectionNo: 0, mirror, image: img });
    const spec: SlideSpec = { title: "Why", bullets: ["One", "Two"] };
    const right = await contentLayout(ctx(false), spec, "content");
    const left = await contentLayout(ctx(true), spec, "content");
    const imgBox = (pl: SlidePlan) => pl.elements.find((el) => el.kind === "image")!.box;
    expect(imgBox(right).x).toBeGreaterThan(SLIDE_W / 2);
    expect(imgBox(left).x).toBe(0);
    expect(imgBox(right).h).toBe(SLIDE_H);
    // Cropped to its panel, so it fills it without distortion.
    const cropped = right.elements.find((el) => el.kind === "image") as any;
    expect(cropped.image.width / cropped.image.height).toBeCloseTo(imgBox(right).w / imgBox(right).h, 1);
  });
});
