/**
 * A brand's palette is derived from whatever colors the user gave, and every
 * place the layouts draw text must stay readable in it: the same pairs and
 * thresholds every curated design is held to (office-designs.test.ts). Run
 * over hundreds of random brand colors, light, dark and garish, because a
 * brand is whatever the user's company happens to use.
 */
import { describe, expect, it } from "vitest";
import { brandPalette } from "./brand-colors.js";
import { contrastRatio } from "./slide-checks.js";
import { normalizeBrand, type Brand } from "./brand-store.js";
import type { OfficeTheme } from "./office-theme.js";

type Role = keyof OfficeTheme["colors"];
const PAIRS: Array<[Role, Role, number]> = [
  ["onDark", "slideDark", 4.5], ["onDarkMuted", "slideDark", 4.5], ["highlight", "slideDark", 3],
  ["onDark", "accent", 4.5], ["onDarkMuted", "accent", 4.5],
  ["heading", "slideBackground", 4.5], ["body", "slideBackground", 4.5], ["muted", "slideBackground", 4.5], ["accent", "slideBackground", 3],
  ["heading", "band", 4.5], ["body", "band", 4.5], ["accent", "band", 3],
];

/** A seeded generator, so a failure names a reproducible color. */
function rng(seed: number) { return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); }
const randomHex = (r: () => number) => [0, 0, 0].map(() => Math.floor(r() * 256).toString(16).padStart(2, "0")).join("").toUpperCase();
const brand = (colors: Partial<Brand["colors"]>) => normalizeBrand({ name: "T", colors }, "t")!;

function failures(colors: OfficeTheme["colors"]): string[] {
  return PAIRS.filter(([fg, bg, min]) => contrastRatio(colors[fg], colors[bg]) < min)
    .map(([fg, bg, min]) => `${fg} #${colors[fg]} on ${bg} #${colors[bg]}: ${contrastRatio(colors[fg], colors[bg]).toFixed(2)} < ${min}`);
}

describe("brand palette", () => {
  it("is readable everywhere for 400 random brands", () => {
    const r = rng(7);
    const bad: string[] = [];
    for (let i = 0; i < 400; i++) {
      const given = i % 3 === 0 ? { primary: randomHex(r) }
        : i % 3 === 1 ? { primary: randomHex(r), secondary: randomHex(r) }
        : { primary: randomHex(r), secondary: randomHex(r), dark: randomHex(r), light: randomHex(r) };
      const p = brandPalette(brand(given))!;
      for (const f of failures(p.colors)) bad.push(`${JSON.stringify(given)} → ${f}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("keeps a bright brand color as the highlight on dark slides, and a readable shade of it as the accent", () => {
    const p = brandPalette(brand({ primary: "FFC20E" }))!;
    expect(p.colors.highlight).toBe("FFC20E");
    expect(contrastRatio("FFFFFF", p.colors.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it("puts headings in the brand's own color, not its dark (NutriShop's orange stays orange)", () => {
    // The brand Peter saved, 2026-11-24: headings came out #111111.
    const p = brandPalette(brand({ primary: "FF5A00", secondary: "222222", accent: "FFD000", dark: "111111", light: "F5F5F5" }))!;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(p.colors.heading.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(150);
    expect(r - b).toBeGreaterThan(120);
    expect(g).toBeLessThan(r);
    expect(contrastRatio(p.colors.heading, p.colors.band)).toBeGreaterThanOrEqual(4.5);
    expect(p.colors.highlight).toBe("FFD000");
  });

  it("gives headings the brand's dark when its color only reads after going nearly black", () => {
    const p = brandPalette(brand({ primary: "FFF27A", dark: "1B1B3A" }))!;
    expect(contrastRatio(p.colors.heading, "FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(p.colors.heading).toBe("1B1B3A");
  });

  it("uses the brand's own dark when white reads on it", () => {
    expect(brandPalette(brand({ primary: "E4572E", dark: "1B1B3A" }))!.colors.slideDark).toBe("1B1B3A");
  });

  it("gives charts the brand's colors first, without repeats", () => {
    const p = brandPalette(brand({ primary: "1F5A3A", secondary: "B5D334" }))!;
    expect(p.chartPalette[1]).toBe("B5D334");
    expect(new Set(p.chartPalette).size).toBe(p.chartPalette.length);
  });

  it("is null for a brand with no colors, so the design's colors stay", () => {
    expect(brandPalette(brand({}))).toBeNull();
  });
});
