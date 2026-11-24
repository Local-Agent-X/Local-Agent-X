/**
 * Which brand a file is made in, and what that brand does to its theme. The
 * Office tools call `brandForCall` with their `brand` argument and pass the
 * brand to resolveOfficeTheme, which layers it over the chosen design.
 *
 * The argument is filled in by code when the user's message names a saved
 * brand (canonical-loop/middlewares/brand-match.ts); without one, the
 * default brand applies if the user set one, and "none" makes a file
 * unbranded.
 */
import { brandDir, brandNamedIn, defaultBrand, findBrand, listBrands, type Brand, type BrandKind } from "./brand-store.js";
import { brandPalette } from "./brand-colors.js";
import type { OfficeThemeOverride } from "./office-theme.js";

/** The theme layer a brand makes: its palette, fonts and company block. */
export function brandOverride(b: Brand): OfficeThemeOverride {
  const palette = brandPalette(b);
  const fonts = { ...(b.fonts.heading ? { heading: b.fonts.heading } : {}), ...(b.fonts.body ? { body: b.fonts.body } : {}) };
  return {
    ...(palette ? { colors: palette.colors, chartPalette: palette.chartPalette } : {}),
    fonts,
    brand: {
      company: b.company ?? b.name,
      author: b.author,
      footer: b.footer,
      logo: b.logo,
      logoOnDark: b.logoOnDark,
      letterhead: b.letterhead,
      dir: brandDir(b.slug),
    },
  };
}

const KIND_LABEL: Record<BrandKind, string> = { deck: "decks", doc: "documents", pdf: "PDFs", sheet: "spreadsheets", email: "emails" };

/** What the agent is told with the file: which brand, what the code already
 *  did, and the brand's rules it must follow itself. */
export function brandNote(b: Brand, kind: BrandKind): string {
  const placed = [
    brandPalette(b) && "colors",
    (b.fonts.heading || b.fonts.body) && "fonts",
    b.logo && "logo",
    b.letterhead && (kind === "doc" || kind === "pdf") && "letterhead",
  ].filter(Boolean);
  const lines = [`Made in the "${b.name}" brand${placed.length ? ` (${placed.join(", ")} applied)` : ""}.`];
  if (b.notes) lines.push(`${b.name} rules: ${b.notes}`);
  if (b.rules[kind]) lines.push(`${b.name} rules for ${KIND_LABEL[kind]}: ${b.rules[kind]}`);
  const templates = b.assets.filter((a) => a.kind === "template");
  if (templates.length) lines.push(`${b.name} keeps templates: ${templates.map((t) => t.file + (t.note ? ` (${t.note})` : "")).join(", ")}.`);
  if (b.notes || b.rules[kind]) lines.push("Check the file against these rules before you hand it over.");
  return lines.join("\n");
}

export type BrandForCall = { brand: Brand | null; note: string } | { error: string };

/** The brand a call is made in: the one it names, "none" for no brand, or
 *  the user's default brand when it names none. */
export function brandForCall(arg: unknown, kind: BrandKind): BrandForCall {
  const ref = typeof arg === "string" ? arg.trim() : "";
  if (ref.toLowerCase() === "none") return { brand: null, note: "" };
  const brand = ref ? findBrand(ref) : defaultBrand();
  if (ref && !brand) {
    const names = listBrands().map((b) => b.name);
    return { error: `No saved brand "${ref}". ${names.length ? `Saved brands: ${names.join(", ")}.` : "No brands are saved yet; the brand tool saves one."}` };
  }
  return { brand, note: brand ? brandNote(brand, kind) : "" };
}

/**
 * What the agent is told, before it starts, when the user's message names a
 * saved brand: that the brand exists, that Office files are made in it
 * without being asked, and that "template" or "style" for that company means
 * the brand. On 2026-11-24 "a push pull split using nutrishop mckinney
 * template" sent the agent searching the workspace for a template file while
 * the saved brand sat unread. Empty when no brand is named.
 */
export function brandTurnNotice(message: string): string {
  let brand: Brand | null;
  try { brand = brandNamedIn(message); } catch { return ""; } // an unreadable library never blocks a turn
  if (!brand) return "";
  // The name is the user's, but this notice is read as the harness's: keep
  // it to characters that cannot close the notice or read as markup.
  const name = brand.name.replace(/[^\p{L}\p{N} &'.,-]/gu, "").slice(0, 80);
  const has = [brandPalette(brand) && "colors", (brand.fonts.heading || brand.fonts.body) && "fonts", brand.logo && "logo",
    brand.letterhead && "letterhead", brand.assets.some((a) => a.kind === "template") && "templates", (brand.notes || Object.keys(brand.rules).length) && "rules"]
    .filter(Boolean).join(", ");
  return `The user's message names the saved brand "${name}" (${has || "nothing saved in it yet"}). ` +
    `A deck, document, PDF, sheet or chart you make for this request is made in it automatically; a "template", "style" or "look" for ${name} means this brand, not a file to search for. ` +
    (has ? `brand(action:"get", name:"${name}") shows what it holds.` : `Its look is empty: ask the user for its colors or logo, or save them with the brand tool when they give them.`);
}

/** The `brand` parameter the Office tools share. */
export const BRAND_PARAM_SCHEMA = {
  type: "string",
  description:
    // The first sentence is all a small model sees (tier-tool-set.ts
    // compactParamDescription), and all it needs: the brand is filled in by
    // code when the user names one.
    "Saved brand to make it in, or \"none\". " +
    "Omit it: a brand the user's message names is filled in for you, else the user's default brand applies. " +
    "The brand sets the file's colors, fonts, logo, letterhead and the rules you check it against.",
} as const;
