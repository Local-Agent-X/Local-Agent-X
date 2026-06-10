/**
 * Office document theme — the single source of truth for how generated Word,
 * Excel, and PowerPoint files look. All three Office tools
 * (document-tools / spreadsheet-tools / presentation-tools) resolve their
 * styling from here so the house style stays consistent across formats.
 *
 * Layering (lowest → highest precedence):
 *   1. DEFAULT_OFFICE_THEME — the baked-in house style (Modern Slate / Navy).
 *   2. User override at ~/.lax/office-theme.json — a partial theme a user (or
 *      a future settings UI) drops in to re-skin every document.
 *   3. Per-call override — a `theme` arg on a tool call, so an explicit agent
 *      instruction ("red headings, Times New Roman") wins for that one file.
 *
 * Colors are stored as bare 6-digit hex (no '#') because that is what the docx
 * and pptxgenjs libraries want; exceljs wants 'FF'+hex (see argb()). Font sizes
 * are in points; docx wants half-points, so use half() at the docx boundary.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";

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
}

export type OfficeThemeOverride = {
  fonts?: Partial<OfficeTheme["fonts"]>;
  colors?: Partial<OfficeTheme["colors"]>;
  doc?: Partial<OfficeTheme["doc"]>;
  ppt?: Partial<OfficeTheme["ppt"]>;
  chartPalette?: string[];
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
  },
  doc: { titleSize: 26, h1Size: 16, h2Size: 13, h3Size: 11.5, bodySize: 11, lineSpacing: 1.15 },
  ppt: { titleSlideSize: 36, sectionSize: 30, titleSize: 24, bodySize: 16, bulletSize: 16, subtitleSize: 14 },
  chartPalette: ["1F3A5F", "3E5C76", "6B8CAE", "A8C0D6", "C9A227", "7A2E3A"],
};

const USER_THEME_PATH = join(getLaxDir(), "office-theme.json");

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
  };
}

/** Strip a leading '#' and uppercase so docx/pptx get bare 6-digit hex. */
export function normalizeHex(c: string): string {
  return String(c).replace(/^#/, "").trim().toUpperCase();
}

let _userThemeCache: { at: number; value: OfficeThemeOverride | null } | null = null;

function loadUserTheme(): OfficeThemeOverride | null {
  if (_userThemeCache && Date.now() - _userThemeCache.at < 5000) return _userThemeCache.value;
  let value: OfficeThemeOverride | null = null;
  try {
    if (existsSync(USER_THEME_PATH)) {
      const parsed = JSON.parse(readFileSync(USER_THEME_PATH, "utf-8"));
      if (isObject(parsed)) value = parsed as OfficeThemeOverride;
    }
  } catch {
    // A malformed user theme must never break document generation — fall back
    // to the house style.
    value = null;
  }
  _userThemeCache = { at: Date.now(), value };
  return value;
}

/**
 * Resolve the effective theme: house style ← user file ← per-call override.
 * `callOverride` may be an object or a JSON string (tool args arrive as
 * strings); a parse failure is ignored so a bad override degrades to the
 * lower layers rather than failing the document.
 */
export function resolveOfficeTheme(callOverride?: unknown): OfficeTheme {
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
  return mergeTheme(mergeTheme(DEFAULT_OFFICE_THEME, loadUserTheme()), parsed);
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
