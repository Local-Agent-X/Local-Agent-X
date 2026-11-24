/**
 * Slide text is measured once and that measurement is law: the layout sizes
 * boxes with it, PowerPoint gets the size it chose, the preview draws its
 * lines. These pin the fit itself.
 */
import { describe, expect, it } from "vitest";
import { bulletIndent, fitText, getMeasurer, wrapParagraph } from "./slide-text-fit.js";

const style = { font: "Arial" };

describe("fitText", () => {
  it("keeps the preferred size when the text fits", async () => {
    const m = await getMeasurer();
    const r = fitText(m, { ...style, paragraphs: ["Short title"], w: 8, h: 1, size: 30, minSize: 18 });
    expect(r).toMatchObject({ size: 30, overflow: false });
    expect(r.lines).toEqual([["Short title"]]);
  });

  it("shrinks until the text fits its box", async () => {
    const m = await getMeasurer();
    const text = "A sentence long enough that at the preferred size it needs more lines than the box can hold";
    const r = fitText(m, { ...style, paragraphs: [text], w: 4, h: 1.2, size: 40, minSize: 10 });
    expect(r.overflow).toBe(false);
    expect(r.size).toBeLessThan(40);
    expect(r.height).toBeLessThanOrEqual(1.2);
  });

  it("reports overflow when even the smallest size does not fit", async () => {
    const m = await getMeasurer();
    const r = fitText(m, { ...style, paragraphs: Array(30).fill("one more line of text here"), w: 3, h: 1, size: 20, minSize: 14 });
    expect(r).toMatchObject({ overflow: true, size: 14 });
  });

  it("takes the bullet indent off the line width", async () => {
    const m = await getMeasurer();
    const plain = fitText(m, { ...style, paragraphs: ["x"], w: 3, h: 1, size: 20, minSize: 10 });
    const bulleted = fitText(m, { ...style, paragraphs: ["x"], w: 3, h: 1, size: 20, minSize: 10, bullets: true });
    expect(plain.indent).toBe(0);
    expect(bulleted.indent).toBe(bulletIndent(20));
  });
});

describe("wrapParagraph", () => {
  it("never leaves a line wider than the box, breaking a word that is", async () => {
    const m = await getMeasurer();
    const maxW = 100;
    const lines = wrapParagraph(m, "supercalifragilisticexpialidocious and more words", 20, style, maxW);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(m.width(l, 20, style)).toBeLessThanOrEqual(maxW);
    expect(lines.join("").replace(/\s/g, "")).toBe("supercalifragilisticexpialidociousandmorewords");
  });
});
