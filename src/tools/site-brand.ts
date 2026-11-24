/**
 * A company's look read from its website: the logo (and icon) candidates,
 * the colors its stylesheets lean on, and its fonts. Used by
 * extract_site_assets' brand mode (asset-tools.ts), which hands the result
 * to the agent to save as a brand, and by the Settings page's "Import from
 * website" (routes/brands.ts), which saves it straight into the brand being
 * edited. Every fetch goes through canonicalFetch, the guarded egress path.
 *
 * Parsing is separate from fetching (parseSiteBrand) so it is tested on
 * saved HTML and CSS without the network.
 */
import { canonicalFetch } from "./web-egress.js";
import { brandFont, brandHex } from "./shared/brand-store.js";
import type { BrandSuggestion } from "./shared/brand-import.js";

export interface SiteBrand extends BrandSuggestion {
  /** Logo and icon URLs, the likeliest logo first. */
  logos: string[];
}

const MAX_HTML = 2_000_000;
const MAX_CSS = 600_000;
const MAX_STYLESHEETS = 3;
const MAX_LOGO_BYTES = 5_000_000;
const UA = { "User-Agent": "Mozilla/5.0 (compatible; LocalAgentX/1.0)" };

const abs = (u: string, base: string): string | null => { try { return new URL(u.trim(), base).toString(); } catch { return null; } };
const attr = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];

/** #rgb, #rrggbb and rgb() colors in a run of CSS, as bare 6-digit hex. */
function cssColors(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) { const h = brandHex(m[1]); if (h) out.push(h); }
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) {
    out.push([m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, "0")).join("").toUpperCase());
  }
  return out;
}

const colorful = (h: string) => { const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); return Math.max(...c) - Math.min(...c) > 36; };
const GENERIC_FONTS = /^(inherit|initial|unset|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|segoe ui|arial|helvetica|helvetica neue|roboto|var\(.*)$/i;

/** The first named family of each font-family declaration, most used first. */
function cssFonts(css: string): string[] {
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const first = m[1].split(",")[0].trim().replace(/["']/g, "");
    const f = brandFont(first);
    if (f && !GENERIC_FONTS.test(f)) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

/** Logo candidates in the order they are likely the logo: an image named or
 *  labelled "logo", then the touch icon, then the favicon. */
function logoCandidates(html: string, base: string): string[] {
  const named: string[] = [], icons: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const label = `${attr(tag, "class") ?? ""} ${attr(tag, "id") ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "src") ?? ""}`;
    const src = attr(tag, "src");
    if (src && /logo/i.test(label) && !src.startsWith("data:")) { const u = abs(src, base); if (u) named.push(u); }
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attr(m[0], "rel")?.toLowerCase() ?? "";
    const href = attr(m[0], "href");
    if (!href || !/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const u = abs(href, base);
    if (u) (rel.includes("apple-touch-icon") ? icons.unshift(u) : icons.push(u));
  }
  return [...new Set([...named, ...icons])].slice(0, 6);
}

/** The look in a page's HTML and the CSS it uses (inline and linked). */
export function parseSiteBrand(html: string, css: string[], baseUrl: string): SiteBrand {
  const styles = [...[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]), ...css].join("\n");
  // Custom properties a site names as its brand colors are the strongest signal.
  const named = [...styles.matchAll(/--[\w-]*(?:primary|brand|accent|secondary|main)[\w-]*\s*:\s*([^;}]+)/gi)]
    .flatMap((m) => cssColors(m[1]));
  const themeColor = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .filter((m) => /name\s*=\s*["']theme-color["']/i.test(m[0]))
    .map((m) => brandHex(attr(m[0], "content"))).filter((h): h is string => !!h);
  const counts = new Map<string, number>();
  for (const c of cssColors(styles)) if (colorful(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  const frequent = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const found = [...new Set([...named.filter(colorful), ...themeColor.filter(colorful), ...frequent])].slice(0, 8);
  const fonts = cssFonts(styles);
  return {
    colors: { primary: found[0], secondary: found[1] },
    fonts: { heading: fonts[0], body: fonts[1] ?? fonts[0] },
    found,
    logos: logoCandidates(html, baseUrl),
    source: baseUrl,
  };
}

async function fetchText(url: string, accept: string, max: number): Promise<string> {
  const res = await canonicalFetch(url, { headers: { ...UA, Accept: accept }, timeoutMs: 20_000 });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  const text = await res.text();
  return text.slice(0, max);
}

/** Fetch a site's page and up to three of its own stylesheets, and read its look. */
export async function readSiteBrand(url: string): Promise<SiteBrand> {
  const html = await fetchText(url, "text/html,application/xhtml+xml", MAX_HTML);
  const origin = new URL(url).origin;
  const sheets = [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((m) => /rel\s*=\s*["'][^"']*stylesheet/i.test(m[0]))
    .map((m) => abs(attr(m[0], "href") ?? "", url))
    .filter((u): u is string => !!u && new URL(u).origin === origin)
    .slice(0, MAX_STYLESHEETS);
  const css = (await Promise.all(sheets.map((s) => fetchText(s, "text/css", MAX_CSS).catch(() => "")))).filter(Boolean);
  return parseSiteBrand(html, css, url);
}

/** One logo candidate's bytes, when it is an image of a sane size. */
export async function fetchLogo(url: string): Promise<{ data: Buffer; name: string } | null> {
  try {
    const res = await canonicalFetch(url, { headers: { ...UA, Accept: "image/*" }, timeoutMs: 20_000 });
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!res.ok || !mime.startsWith("image/")) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < 64 || data.length > MAX_LOGO_BYTES) return null;
    const ext = mime === "image/svg+xml" ? "svg" : mime === "image/x-icon" || mime === "image/vnd.microsoft.icon" ? "ico" : mime.split("/")[1].replace("jpeg", "jpg");
    return { data, name: `logo.${ext}` };
  } catch { return null; }
}
