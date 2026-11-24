/**
 * Office document theme — the single source of truth for how generated Word,
 * Excel, and PowerPoint files look. All three Office tools
 * (document-tools / spreadsheet-tools / presentation-tools) resolve their
 * styling from here so the house style stays consistent across formats.
 *
 * Layering (lowest → highest precedence):
 *   1. DEFAULT_OFFICE_THEME — the baked-in house style (Modern Slate / Navy),
 *      or the curated design chosen for the file (office-designs.ts).
 *   2. The brand the file is made in — a company's saved look from the brand
 *      library (brand-store.ts, brand-theme.ts). Until 2026-11-23 this layer
 *      was one global ~/.lax/office-theme.json; it is migrated into a brand.
 *   3. Per-call override — a `theme` arg on a tool call, so an explicit agent
 *      instruction ("red headings, Times New Roman") wins for that one file.
 *
 * Colors are stored as bare 6-digit hex (no '#') because that is what the docx
 * and pptxgenjs libraries want; exceljs wants 'FF'+hex (see argb()). Font sizes
 * are in points; docx wants half-points, so use half() at the docx boundary.
 */

import { OFFICE_DESIGNS, isOfficeDesignName } from "./office-designs.js";
import type { Brand } from "./brand-store.js";
import { brandOverride } from "./brand-theme.js";

export interface OfficeTheme {
  fonts: { heading: string; body: string };
  colors: {
    heading: string;     // primary heading ink
    subheading: string;  // secondary heading ink
    body: string;        // body text
    accent: string;      // rules, header fills, slide accents
    accentText: string;  // text drawn on top of an accent fill
    band: string;        // banded table/row fill
    border: string;      // table/cell borders
    muted: string;       // captions, footers, subtitles
    // Slides only (Word/Excel/PDF never read these): the ground a slide is
    // painted on. Every slide was white before, so a cover was a memo page.
    slideBackground: string; // content slides
    slideDark: string;       // cover, section, closing, photo slides
    onDark: string;          // text on slideDark / accent grounds
    onDarkMuted: string;     // secondary text on dark grounds
    highlight: string;       // the second accent: rules and marks on dark
  };
  doc: {
    titleSize: number; h1Size: number; h2Size: number; h3Size: number;
    bodySize: number; lineSpacing: number; // 1.0 = single
  };
  ppt: {
    titleSlideSize: number; sectionSize: number; titleSize: number;
    bodySize: number; bulletSize: number; subtitleSize: number;
  };
  /** Series colors for native charts, accent-led. */
  chartPalette: string[];
  /** OPT-IN, the USER's own brand — never the app's. Empty by default, so
   *  documents are unbranded unless a user fills this in. */
  brand: OfficeBrand;
}

export interface OfficeBrand {
  /** Company or person name — used for the footer + file author metadata. */
  company?: string;
  /** File author/creator metadata. Defaults to `company`. Never the app name. */
  author?: string;
  /** Logo image — URL or workspace path (png/jpeg). Placed on the doc header /
   *  title slide / PDF masthead. */
  logo?: string;
  /** Footer tagline. Defaults to `company`. */
  footer?: string;
  /** For dark grounds (cover, closing slides), when the logo is dark. */
  logoOnDark?: string;
  /** A full-width header image a document or PDF opens with. */
  letterhead?: string;
  /** The brand library folder the three images above are files in. Set only
   *  by the brand layer, never by a call: a call's logo resolves from the
   *  workspace like any file it names. */
  dir?: string;
}

export type OfficeThemeOverride = {
  fonts?: Partial<OfficeTheme["fonts"]>;
  colors?: Partial<OfficeTheme["colors"]>;
  doc?: Partial<OfficeTheme["doc"]>;
  ppt?: Partial<OfficeTheme["ppt"]>;
  chartPalette?: string[];
  brand?: Partial<OfficeBrand>;
};

// ── Baked-in house style: "Modern Slate" + Navy accent ──────────────────────
// Calibri is the cross-platform-safe sans: native on Windows/Mac Office,
// metric-substituted by Carlito on LibreOffice/Linux, Helvetica on bare macOS.
export const DEFAULT_OFFICE_THEME: OfficeTheme = {
  fonts: { heading: "Calibri", body: "Calibri" },
  colors: {
    heading: "222428",
    subheading: "2B2F36",
    body: "23262B",
    accent: "1F3A5F",
    accentText: "FFFFFF",
    band: "F2F5F9",
    border: "D9DEE5",
    muted: "6B7280",
    slideBackground: "FFFFFF",
    slideDark: "0F1B2D",
    onDark: "FFFFFF",
    onDarkMuted: "B6C2D3",
    highlight: "C9A227",
  },
  doc: { titleSize: 26, h1Size: 16, h2Size: 13, h3Size: 11.5, bodySize: 11, lineSpacing: 1.15 },
  ppt: { titleSlideSize: 36, sectionSize: 30, titleSize: 24, bodySize: 16, bulletSize: 16, subtitleSize: 14 },
  chartPalette: ["1F3A5F", "3E5C76", "6B8CAE", "A8C0D6", "C9A227", "7A2E3A"],
  brand: {}, // unbranded by default — no app branding, no user branding
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shallow-per-section merge: each known section (fonts/colors/doc/ppt) is
 *  spread, chartPalette is replaced wholesale. Unknown keys are ignored so a
 *  malformed override can't inject arbitrary fields. */
function mergeTheme(base: OfficeTheme, ov?: OfficeThemeOverride | null): OfficeTheme {
  if (!ov || !isObject(ov)) return base;
  return {
    fonts: { ...base.fonts, ...(isObject(ov.fonts) ? ov.fonts : {}) },
    colors: { ...base.colors, ...(isObject(ov.colors) ? ov.colors : {}) },
    doc: { ...base.doc, ...(isObject(ov.doc) ? ov.doc : {}) },
    ppt: { ...base.ppt, ...(isObject(ov.ppt) ? ov.ppt : {}) },
    chartPalette: Array.isArray(ov.chartPalette) && ov.chartPalette.length
      ? ov.chartPalette.map(normalizeHex)
      : base.chartPalette,
    brand: { ...base.brand, ...(isObject(ov.brand) ? ov.brand : {}) },
  };
}

/** File author/creator metadata — the user's brand, NEVER the app name. Empty
 *  when the user hasn't set a brand (so documents carry no app branding). */
export function brandAuthor(t: OfficeTheme): string {
  return (t.brand.author || t.brand.company || "").trim();
}

/** Footer line text, or "" when unbranded. */
export function brandFooter(t: OfficeTheme): string {
  return (t.brand.footer || t.brand.company || "").trim();
}

/** Strip a leading '#' and uppercase so docx/pptx get bare 6-digit hex. */
export function normalizeHex(c: string): string {
  return String(c).replace(/^#/, "").trim().toUpperCase();
}

/** The theme a curated design makes: the house style with the design's
 *  palette, fonts and chart colors. Unknown names give the house style. */
export function designTheme(design: unknown): OfficeTheme {
  if (!isOfficeDesignName(design)) return DEFAULT_OFFICE_THEME;
  const d = OFFICE_DESIGNS[design];
  return { ...DEFAULT_OFFICE_THEME, fonts: { ...d.fonts }, colors: { ...d.colors }, chartPalette: [...d.chartPalette] };
}

/**
 * Resolve the effective theme: house style (or the chosen curated design,
 * office-designs.ts) ← the brand (brand-theme.ts brandForCall) ← per-call
 * override.
 * `callOverride` may be an object or a JSON string (tool args arrive as
 * strings); a parse failure is ignored so a bad override degrades to the
 * lower layers rather than failing the document.
 */
export function resolveOfficeTheme(callOverride?: unknown, design?: unknown, brand?: Brand | null): OfficeTheme {
  let parsed: OfficeThemeOverride | null = null;
  if (typeof callOverride === "string" && callOverride.trim()) {
    try { parsed = JSON.parse(callOverride); } catch { parsed = null; }
  } else if (isObject(callOverride)) {
    parsed = callOverride as OfficeThemeOverride;
  }
  // Normalize any color hexes the caller passed with a leading '#'.
  if (parsed && isObject(parsed.colors)) {
    parsed.colors = Object.fromEntries(
      Object.entries(parsed.colors).map(([k, v]) => [k, typeof v === "string" ? normalizeHex(v) : v]),
    ) as Partial<OfficeTheme["colors"]>;
  }
  // A call never sets where brand files live: only the brand layer does.
  if (parsed && isObject(parsed.brand)) delete (parsed.brand as { dir?: string }).dir;
  const theme = mergeTheme(mergeTheme(designTheme(design), brand ? brandOverride(brand) : null), parsed);
  // A logo the call names is the call's own file, found in the workspace.
  if (parsed && isObject(parsed.brand) && parsed.brand.logo) theme.brand = { ...theme.brand, dir: undefined };
  return theme;
}

/** Points → half-points (docx run/heading size unit). */
export function half(pt: number): number { return Math.round(pt * 2); }

/** Bare hex → exceljs ARGB ('FF' + hex). */
export function argb(hex: string): string { return "FF" + normalizeHex(hex); }

/** JSON-schema fragment for the optional per-call `theme` override, shared by
 *  the three Office create-tools so their parameter docs stay identical. */
export const THEME_PARAM_SCHEMA = {
  type: "string",
  description:
    "Optional JSON theme override for THIS file only. Omit to use the built-in " +
    "professional house style (recommended). Only pass this when the user asks " +
    "for a specific look that differs from the default. Shape: " +
    '{"fonts":{"heading":"Times New Roman","body":"Times New Roman"},' +
    '"colors":{"accent":"#7A2E3A","heading":"000000"}}.',
} as const;
