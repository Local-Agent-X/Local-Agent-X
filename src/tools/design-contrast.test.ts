/**
 * Contrast conformance for every archetype palette, in BOTH modes.
 *
 * The anti-patterns have demanded 4.5:1 since the design system shipped, but
 * nothing measured it — the rule was advice to a model, and the palettes it was
 * advising were hand-picked. This computes the real WCAG ratio for every pair a
 * builder is told to put together and fails below the line, so a palette cannot
 * be authored (or edited) into unreadable text without the build saying so.
 *
 * OKLCH → sRGB is implemented here rather than pulled in: it is thirty lines of
 * documented matrix math, and a color dependency for a test is not worth the
 * supply chain. Out-of-gamut values are clamped, which is what a browser does
 * when it renders them, so the ratio measured is the ratio a user sees.
 */
import { describe, it, expect } from "vitest";
import { PALETTES, type PaletteTokens } from "./design-palettes.js";

/** Parse `oklch(L C H)` — the only notation the palettes use. */
function parseOklch(value: string): { l: number; c: number; h: number } {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  if (!m) throw new Error(`not an oklch() value: ${value}`);
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
}

/** OKLCH → linear-light sRGB, clamped to gamut (as a browser renders it). */
function toLinearRgb(value: string): [number, number, number] {
  const { l, c, h } = parseOklch(value);
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);

  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return [
    clamp(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    clamp(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    clamp(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
  ];
}

/** WCAG 2.x relative luminance — linear sRGB is already what it wants. */
function luminance(value: string): number {
  const [r, g, b] = toLinearRgb(value);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

type TokenName = keyof PaletteTokens;

/** Pairs a builder is instructed to place together, with the floor each must clear.
 *  4.5 is WCAG AA for body text; 1.4 is the empirical floor for a separator to
 *  read as an edge rather than as nothing. */
const TEXT_PAIRS: Array<[fg: TokenName, bg: TokenName]> = [
  ["text", "bg"],
  ["text", "bgSubtle"],
  ["text", "surface"],
  ["text", "surfaceHover"],
  ["text", "accentSubtle"],
  ["textMuted", "bg"],
  ["textMuted", "surface"],
  ["accentContrast", "accent"],
  ["accentContrast", "accentHover"],
];

/** Edges carry two different jobs and so two different floors. `border` is the
 *  structural edge of a card or input — it has to read as a line from across the
 *  room. `borderSubtle` is a hairline between rows inside one component; forcing
 *  it to the same ratio would stop it being subtle, which is its whole purpose. */
const EDGE_PAIRS: Array<[edge: TokenName, on: TokenName, floor: number]> = [
  ["border", "bg", 1.5],
  ["border", "surface", 1.5],
  ["accentBorder", "bg", 1.5],
  ["borderSubtle", "surface", 1.15],
];

const MODES = [
  { name: "light", idx: 0 },
  { name: "dark", idx: 1 },
] as const;

describe("archetype palettes — WCAG contrast", () => {
  for (const [paletteId, tokens] of Object.entries(PALETTES)) {
    for (const mode of MODES) {
      const value = (t: TokenName) => tokens[t][mode.idx];

      it(`${paletteId} (${mode.name}) meets 4.5:1 on every text pair`, () => {
        for (const [fg, bg] of TEXT_PAIRS) {
          const ratio = contrast(value(fg), value(bg));
          expect(
            ratio,
            `${paletteId}/${mode.name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      });

      it(`${paletteId} (${mode.name}) keeps every edge visible`, () => {
        for (const [edge, on, floor] of EDGE_PAIRS) {
          const ratio = contrast(value(edge), value(on));
          expect(
            ratio,
            `${paletteId}/${mode.name}: ${edge} on ${on} is ${ratio.toFixed(2)}:1 (floor ${floor})`,
          ).toBeGreaterThanOrEqual(floor);
        }
      });
    }
  }

  // A dark mode that is merely the light ramp re-listed would pass every ratio
  // above while looking identical — the pairing is the point, so assert the
  // modes actually diverge.
  it("every palette genuinely inverts between modes", () => {
    for (const [paletteId, tokens] of Object.entries(PALETTES)) {
      const lightBg = luminance(tokens.bg[0]);
      const darkBg = luminance(tokens.bg[1]);
      expect(lightBg, `${paletteId}: light bg is not light`).toBeGreaterThan(0.6);
      expect(darkBg, `${paletteId}: dark bg is not dark`).toBeLessThan(0.1);
    }
  });
});
