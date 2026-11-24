/**
 * Every curated design is readable in every place the slide layouts put
 * text: the same WCAG thresholds the deck check applies (slide-checks.ts),
 * 4.5:1 for normal text and 3:1 for large. A design the agent can pick must
 * never produce a slide the check then flags.
 */
import { describe, expect, it } from "vitest";
import { OFFICE_DESIGNS, OFFICE_DESIGN_NAMES } from "./office-designs.js";
import { contrastRatio } from "./slide-checks.js";

type Role = keyof (typeof OFFICE_DESIGNS)["midnight"]["colors"];

/** [text role, ground role, minimum ratio, where the layouts draw it] */
const PAIRS: Array<[Role, Role, number, string]> = [
  ["onDark", "slideDark", 4.5, "cover tagline, section and closing text"],
  ["onDarkMuted", "slideDark", 4.5, "cover contact block, slide numbers on dark"],
  ["highlight", "slideDark", 3, "section number"],
  ["onDark", "accent", 4.5, "statement"],
  ["onDarkMuted", "accent", 4.5, "statement kicker, slide numbers on the accent"],
  ["heading", "slideBackground", 4.5, "titles"],
  ["body", "slideBackground", 4.5, "body and bullets"],
  ["muted", "slideBackground", 4.5, "attribution, notes, slide numbers"],
  ["accent", "slideBackground", 3, "big numbers, quote mark"],
  ["heading", "band", 4.5, "column headings"],
  ["body", "band", 4.5, "column text, stat labels"],
  ["accent", "band", 3, "stat values on their cards"],
];

describe("curated designs", () => {
  it("are at least eight, each saying what it suits", () => {
    expect(OFFICE_DESIGN_NAMES.length).toBeGreaterThanOrEqual(8);
    for (const name of OFFICE_DESIGN_NAMES) expect(OFFICE_DESIGNS[name].suits.length, name).toBeGreaterThan(20);
  });

  for (const name of OFFICE_DESIGN_NAMES) {
    it(`${name} is readable wherever the layouts put text`, () => {
      const c = OFFICE_DESIGNS[name].colors as Record<Role, string>;
      const failures = PAIRS
        .map(([fg, bg, min, where]) => ({ fg, bg, min, where, ratio: contrastRatio(c[fg], c[bg]) }))
        .filter((x) => x.ratio < x.min)
        .map((x) => `${x.fg} on ${x.bg} (${x.where}): ${x.ratio.toFixed(2)} < ${x.min}`);
      expect(failures).toEqual([]);
    });
  }

  it("look different from one another: no two share a ground and an accent", () => {
    const keys = OFFICE_DESIGN_NAMES.map((n) => `${OFFICE_DESIGNS[n].colors.slideDark}/${OFFICE_DESIGNS[n].colors.accent}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
