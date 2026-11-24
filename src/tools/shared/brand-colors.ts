/**
 * A brand gives a few colors (its primary, maybe a second, maybe a dark);
 * a document needs a full palette: ink for titles and text, a dark ground
 * for covers, a band for cards, a highlight. This derives that palette from
 * the brand's own colors and holds every pair the layouts draw to the same
 * contrast the curated designs meet (office-designs.test.ts PAIRS): a brand's
 * bright yellow stays as the highlight on dark slides, and a readable shade
 * of it becomes the accent white text sits on.
 */
import type { OfficeTheme } from "./office-theme.js";
import { contrastRatio } from "./slide-checks.js";
import type { Brand } from "./brand-store.js";

const rgb = (h: string) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c: number[]) => c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase();

/** `a` moved toward `b` by `t` (0 = a, 1 = b). */
export function mixHex(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((v, i) => v + (y[i] - v) * t));
}

/** `c` moved toward `toward` in small steps until it reaches `min` contrast
 *  against `against`; the closest step to the brand's own color that does. */
export function untilContrast(c: string, against: string, min: number, toward: "000000" | "FFFFFF"): string {
  for (let t = 0; t <= 1.0001; t += 0.04) {
    const m = mixHex(c, toward, t);
    if (contrastRatio(m, against) >= min) return m;
  }
  return toward;
}

/** Saturation-ish: how far from grey (0–255). Greys make poor accents. */
const chroma = (h: string) => { const c = rgb(h); return Math.max(...c) - Math.min(...c); };

/** The palette a brand's colors make, or null when the brand has none. */
export function brandPalette(b: Brand): { colors: OfficeTheme["colors"]; chartPalette: string[] } | null {
  const primary = b.colors.primary ?? b.colors.accent ?? b.colors.secondary ?? b.colors.dark;
  if (!primary) return null;
  const second = [b.colors.secondary, b.colors.accent].find((c) => c && c !== primary);

  // The dark ground: the brand's dark when white reads on it, else the
  // primary taken most of the way to black so it still carries the hue.
  const darkBase = b.colors.dark && contrastRatio("FFFFFF", b.colors.dark) >= 9 ? b.colors.dark : mixHex(primary, "000000", 0.72);
  const slideDark = untilContrast(darkBase, "FFFFFF", 9, "000000");
  // The accent white text and muted text sit on: the primary, darkened only
  // as far as reading needs.
  const accent = untilContrast(primary, "FFFFFF", 5.6, "000000");
  // Muted text on dark grounds: a tint of the dark that still reads on both
  // the dark and the accent.
  let onDarkMuted = mixHex(slideDark, "FFFFFF", 0.7);
  for (let t = 0.7; t < 1 && Math.min(contrastRatio(onDarkMuted, slideDark), contrastRatio(onDarkMuted, accent)) < 4.5; t += 0.03) {
    onDarkMuted = mixHex(slideDark, "FFFFFF", t);
  }
  if (Math.min(contrastRatio(onDarkMuted, slideDark), contrastRatio(onDarkMuted, accent)) < 4.5) onDarkMuted = "FFFFFF";
  // The highlight: the brand's own bright color where it shows on the dark.
  const highlight = [second, primary, b.colors.accent, mixHex(primary, "FFFFFF", 0.55), "D4AF37"]
    .find((c): c is string => !!c && chroma(c) > 40 && contrastRatio(c, slideDark) >= 3)
    ?? untilContrast(primary, slideDark, 3, "FFFFFF");
  const heading = untilContrast(b.colors.dark ?? mixHex(primary, "000000", 0.65), "FFFFFF", 9, "000000");
  const band = b.colors.light && contrastRatio(b.colors.light, "000000") >= 17 ? b.colors.light : mixHex(primary, "FFFFFF", 0.93);
  const body = untilContrast(mixHex("23262B", slideDark, 0.25), band, 7, "000000");
  const colors: OfficeTheme["colors"] = {
    heading: untilContrast(heading, band, 4.5, "000000"),
    subheading: untilContrast(mixHex(heading, "FFFFFF", 0.12), "FFFFFF", 7, "000000"),
    body,
    accent: untilContrast(accent, band, 3, "000000"),
    accentText: "FFFFFF",
    band,
    border: mixHex(primary, "FFFFFF", 0.78),
    muted: untilContrast(mixHex("6B7280", primary, 0.15), "FFFFFF", 4.6, "000000"),
    slideBackground: "FFFFFF",
    slideDark,
    onDark: "FFFFFF",
    onDarkMuted,
    highlight,
  };
  const chartPalette = [colors.accent, ...(second ? [second] : []), highlight, mixHex(colors.accent, "FFFFFF", 0.4), mixHex(colors.accent, "FFFFFF", 0.65), colors.muted]
    .filter((c, i, all) => all.indexOf(c) === i).slice(0, 6);
  return { colors, chartPalette };
}
