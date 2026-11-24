/**
 * A brand's colors and fonts read from what the user already has, instead
 * of typed in: an Office template's theme (the colors and fonts every
 * PowerPoint, Word and Excel file carries in its theme part) or a logo
 * image's dominant colors. The result is a suggestion the caller saves into
 * a brand (brand-store.ts saveBrand); nothing here writes.
 */
import { extname } from "node:path";
import { brandFont, type Brand } from "./brand-store.js";
import { contrastRatio } from "./slide-checks.js";

export interface BrandSuggestion {
  colors: Partial<Brand["colors"]>;
  fonts: Brand["fonts"];
  /** Every color found, most prominent first, for the user to pick from. */
  found: string[];
  source: string;
}

const THEME_PARTS = ["ppt/theme/theme1.xml", "word/theme/theme1.xml", "xl/theme/theme1.xml"];
export const OFFICE_TEMPLATE_EXT = new Set([".pptx", ".potx", ".docx", ".dotx", ".xlsx", ".xltx"]);

/** One color slot of a theme's color scheme (`<a:accent1>`, `<a:dk2>` …):
 *  an explicit sRGB value, or the system color's last known value. */
function slot(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<a:${name}>([\\s\\S]*?)</a:${name}>`));
  if (!m) return undefined;
  const v = m[1].match(/<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/) ?? m[1].match(/<a:sysClr\b[^>]*\blastClr="([0-9A-Fa-f]{6})"/);
  return v?.[1].toUpperCase();
}

const latin = (xml: string, which: "majorFont" | "minorFont") =>
  brandFont(xml.match(new RegExp(`<a:${which}>[\\s\\S]*?<a:latin\\b[^>]*\\btypeface="([^"]*)"`))?.[1]);

/** Greys and near-whites make poor brand colors; keep the colorful ones. */
const colorful = (h: string) => { const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); return Math.max(...c) - Math.min(...c) > 36; };

/** The theme in an Office file (.pptx/.potx/.docx/.dotx/.xlsx/.xltx). */
export async function suggestFromOfficeFile(data: Buffer, name: string): Promise<BrandSuggestion> {
  if (!OFFICE_TEMPLATE_EXT.has(extname(name).toLowerCase())) throw new Error(`${name} is not a PowerPoint, Word or Excel file.`);
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(data);
  const part = THEME_PARTS.map((p) => zip.file(p)).find(Boolean);
  if (!part) throw new Error(`${name} has no theme to read colors and fonts from.`);
  const xml = await part.async("string");
  const accents = [1, 2, 3, 4, 5, 6].map((i) => slot(xml, `accent${i}`)).filter((c): c is string => !!c);
  const dark = [slot(xml, "dk2"), slot(xml, "dk1")].find((c) => c && contrastRatio(c, "FFFFFF") >= 7);
  const light = slot(xml, "lt2");
  const brandish = accents.filter(colorful);
  return {
    colors: {
      primary: brandish[0] ?? accents[0],
      secondary: brandish[1],
      ...(dark ? { dark } : {}),
      ...(light && contrastRatio(light, "000000") >= 17 ? { light } : {}),
    },
    fonts: { heading: latin(xml, "majorFont"), body: latin(xml, "minorFont") },
    found: [...new Set([...accents, ...(dark ? [dark] : [])])],
    source: name,
  };
}

/**
 * The colors a logo is made of, most area first: shrunk, bucketed so near
 * shades count together, and with white, black and grey left out (a logo's
 * background and outline are rarely the brand's color).
 */
export async function suggestFromImage(data: Buffer, name: string): Promise<BrandSuggestion> {
  const sharp = (await import("sharp")).default;
  const { data: px, info } = await sharp(data, { density: 150 }).resize(96, 96, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Each bucket of near shades remembers its exact colors, and speaks for
  // the commonest one: a logo's ink is one exact hex, and edge pixels the
  // shrink blended would pull an average off it.
  const buckets = new Map<string, { n: number; exact: Map<string, number> }>();
  for (let i = 0; i < px.length; i += info.channels) {
    if (px[i + 3] < 128) continue;
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    if (Math.max(r, g, b) - Math.min(r, g, b) < 28) continue;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const e = buckets.get(key) ?? { n: 0, exact: new Map<string, number>() };
    const hex = [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
    e.n++; e.exact.set(hex, (e.exact.get(hex) ?? 0) + 1);
    buckets.set(key, e);
  }
  const ranked = [...buckets.values()].sort((a, b) => b.n - a.n)
    .map((e) => [...e.exact.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  // Neighbouring buckets of one ink: keep a color only when it differs from
  // every color kept before it.
  const distinct: string[] = [];
  const far = (a: string, b: string) => [0, 2, 4].reduce((d, i) => d + Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)), 0) > 90;
  for (const c of ranked) if (distinct.every((d) => far(c, d))) distinct.push(c);
  return { colors: { primary: distinct[0], secondary: distinct[1] }, fonts: {}, found: distinct.slice(0, 6), source: name };
}

/** Whichever reader the file needs. */
export async function suggestFromFile(data: Buffer, name: string): Promise<BrandSuggestion> {
  return OFFICE_TEMPLATE_EXT.has(extname(name).toLowerCase()) ? suggestFromOfficeFile(data, name) : suggestFromImage(data, name);
}
