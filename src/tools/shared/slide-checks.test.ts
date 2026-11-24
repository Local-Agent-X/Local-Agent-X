/**
 * The deck check the agent gets before it hands a deck over: what would be
 * wrong on screen, found from the plans.
 */
import { describe, expect, it } from "vitest";
import { checkDeck, contrastRatio, MAX_WORDS_PER_SLIDE } from "./slide-checks.js";
import type { SlidePlan, TextElement } from "./slide-plan.js";

function text(over: Partial<TextElement> = {}): TextElement {
  return {
    kind: "text", box: { x: 1, y: 1, w: 4, h: 1 }, paragraphs: ["Hello"], font: "Arial", color: "222428",
    align: "left", valign: "top", lineSpacing: 1, paraGap: 0.3, bullets: false, role: "body",
    fit: { size: 18, lines: [["Hello"]], height: 0.3, overflow: false, indent: 0 },
    ...over,
  };
}
const slide = (elements: SlidePlan["elements"], layout = "content", background = "FFFFFF"): SlidePlan => ({ layout, background, elements });

describe("contrastRatio", () => {
  it("is the WCAG ratio", () => {
    expect(contrastRatio("000000", "FFFFFF")).toBeCloseTo(21, 0);
    expect(contrastRatio("FFFFFF", "FFFFFF")).toBeCloseTo(1, 5);
  });
});

describe("checkDeck", () => {
  it("passes a readable slide", () => {
    expect(checkDeck([slide([text()])])).toEqual([]);
  });

  it("flags text that does not fit even at its smallest size", () => {
    const el = text({ fit: { size: 12, lines: [["x"]], height: 3, overflow: true, indent: 0 } });
    expect(checkDeck([slide([el])])[0]).toMatch(/slide 1: the body .* does not fit/);
  });

  it("judges contrast against the shape under the text, not just the slide", () => {
    const pale = text({ color: "B6C2D3" });
    expect(checkDeck([slide([pale])]).join()).toMatch(/hard to read/);
    // The same pale text on a dark card is fine.
    const card = { kind: "rect" as const, box: { x: 0, y: 0, w: 13, h: 7 }, color: "0F1B2D" };
    expect(checkDeck([slide([card, pale])])).toEqual([]);
  });

  it("does not judge contrast over a photo, which has no single color", () => {
    const photo = { kind: "image" as const, box: { x: 0, y: 0, w: 13, h: 7 }, image: {} as never, alt: "" };
    expect(checkDeck([slide([photo, text({ color: "FFFFFF" })])])).toEqual([]);
  });

  it("flags a slide with more words than a projected slide can carry", () => {
    const words = Array(MAX_WORDS_PER_SLIDE + 5).fill("word").join(" ");
    expect(checkDeck([slide([text({ paragraphs: [words] })])]).join()).toMatch(/too much to read/);
  });

  it("flags a run of one layout, the sameness an audience feels", () => {
    const content = slide([text()]);
    expect(checkDeck([content, content])).toEqual([]);
    expect(checkDeck([content, content, content]).join()).toMatch(/slides 1-3: 3 "content" slides in a row/);
    const stats = slide([text()], "stats");
    expect(checkDeck([stats, stats]).join()).toMatch(/2 "stats" slides in a row/);
  });
});
