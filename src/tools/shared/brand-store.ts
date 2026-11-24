/**
 * The brand library: each company's look, saved once and applied in code, so
 * a NutriShop document comes out in NutriShop's colors, fonts, logo and
 * letterhead without the agent having to remember them.
 *
 * One folder per brand under the data dir, `brands/<slug>/`: `brand.json`
 * plus the brand's own files (logo, letterhead, templates, references).
 * Synced across machines with the other brain folders (sync/constants.ts
 * BRAIN_DIRS); a delete leaves a tombstone so it reaches them too.
 *
 * Written by the Settings page (routes/brands.ts) and by the agent's `brand`
 * tool; read by every Office tool through brand-theme.ts. Before 2026-11-23
 * one global office-theme.json held the user's look; it is migrated into a
 * brand marked default the first time the library is read. The brand's files
 * (copying in, removing, the whole brand to the trash) are brand-files.ts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";

export const BRAND_KINDS = ["deck", "doc", "pdf", "sheet", "email"] as const;
export type BrandKind = (typeof BRAND_KINDS)[number];

export const BRAND_COLOR_ROLES = ["primary", "secondary", "accent", "dark", "light"] as const;
export type BrandColorRole = (typeof BRAND_COLOR_ROLES)[number];

export const BRAND_ASSET_KINDS = ["template", "reference", "image"] as const;
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number];

export interface BrandAsset { file: string; kind: BrandAssetKind; note?: string }

export interface Brand {
  name: string;
  slug: string;
  /** Other names the user calls it by; any of them in a request applies it. */
  aliases: string[];
  /** Applied to a file that names no brand. At most one brand is default. */
  isDefault: boolean;
  colors: Partial<Record<BrandColorRole, string>>;
  fonts: { heading?: string; body?: string };
  company?: string;
  author?: string;
  footer?: string;
  /** File names inside the brand's folder. */
  logo?: string;
  logoOnDark?: string;
  letterhead?: string;
  assets: BrandAsset[];
  /** Rules for everything made in this brand ("never abbreviate the name"). */
  notes?: string;
  /** Rules for one kind of file ("docs always open with the letterhead"). */
  rules: Partial<Record<BrandKind, string>>;
  updatedAt: string;
}

/** What a caller may set; everything but the name is optional. */
export type BrandInput = Partial<Omit<Brand, "slug" | "updatedAt" | "assets">> & { name?: string };

export const brandsDir = (): string => join(getLaxDir(), "brands");
export const brandDir = (slug: string): string => join(brandsDir(), slug);

const MAX_TEXT = 4000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A folder-safe slug: lowercase letters, digits and dashes, at most 40. */
export function brandSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "brand";
}

/** A 6-digit hex color without '#', uppercased, or undefined when it is not one. */
export function brandHex(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const h = v.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) return h.split("").map((c) => c + c).join("").toUpperCase();
  return /^[0-9a-f]{6}$/i.test(h) ? h.toUpperCase() : undefined;
}

/** A font family name: letters, digits, spaces and dashes only. */
export function brandFont(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const f = v.replace(/["']/g, "").replace(/[^A-Za-z0-9 \-]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return f || undefined;
}

const text = (v: unknown, max = MAX_TEXT): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** A file name that stays inside the brand folder. */
const fileName = (v: unknown): string | undefined =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(v) && !v.includes("..") ? v : undefined;

/** Every field checked and trimmed, so a hand-edited or synced brand.json
 *  can never put a path, a script or a malformed color into a document. */
export function normalizeBrand(raw: unknown, slug: string): Brand | null {
  if (!isObj(raw)) return null;
  const name = text(raw.name, 80);
  if (!name) return null;
  const colors: Brand["colors"] = {};
  if (isObj(raw.colors)) for (const r of BRAND_COLOR_ROLES) { const h = brandHex(raw.colors[r]); if (h) colors[r] = h; }
  const fonts = isObj(raw.fonts) ? { heading: brandFont(raw.fonts.heading), body: brandFont(raw.fonts.body) } : {};
  const rules: Brand["rules"] = {};
  if (isObj(raw.rules)) for (const k of BRAND_KINDS) { const r = text(raw.rules[k]); if (r) rules[k] = r; }
  const assets = Array.isArray(raw.assets)
    ? raw.assets.flatMap((a): BrandAsset[] => {
      if (!isObj(a)) return [];
      const file = fileName(a.file);
      const kind = BRAND_ASSET_KINDS.find((k) => k === a.kind) ?? "reference";
      return file ? [{ file, kind, ...(text(a.note, 300) ? { note: text(a.note, 300) } : {}) }] : [];
    })
    : [];
  const aliases = Array.isArray(raw.aliases)
    ? [...new Set(raw.aliases.map((a) => text(a, 60)).filter((a): a is string => !!a))].slice(0, 12)
    : [];
  return {
    name, slug, aliases, isDefault: raw.isDefault === true, colors, fonts,
    company: text(raw.company, 120), author: text(raw.author, 120), footer: text(raw.footer, 200),
    logo: fileName(raw.logo), logoOnDark: fileName(raw.logoOnDark), letterhead: fileName(raw.letterhead),
    assets, notes: text(raw.notes), rules,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
  };
}

function readBrand(slug: string): Brand | null {
  try { return normalizeBrand(JSON.parse(readFileSync(join(brandDir(slug), "brand.json"), "utf-8")), slug); }
  catch { return null; }
}

/** Write brand.json through a temp file, so a crash never leaves half a brand. */
export function writeBrand(b: Brand): void {
  const dir = brandDir(b.slug);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "brand.json.tmp");
  writeFileSync(tmp, JSON.stringify(b, null, 2), "utf-8");
  renameSync(tmp, join(dir, "brand.json"));
}

/**
 * The look a user set before the library existed (office-theme.json: theme
 * colors, fonts and a company block) becomes a brand marked default, so
 * their documents keep it, and the file is renamed so this runs once.
 */
function migrateLegacyTheme(): void {
  const legacy = join(getLaxDir(), "office-theme.json");
  if (!existsSync(legacy)) return;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(legacy, "utf-8")); } catch { return; }
  if (isObj(raw)) {
    const c = isObj(raw.colors) ? raw.colors : {}, f = isObj(raw.fonts) ? raw.fonts : {}, b = isObj(raw.brand) ? raw.brand : {};
    const colors = { primary: brandHex(c.accent), dark: brandHex(c.heading) ?? brandHex(c.slideDark), secondary: brandHex(c.highlight) };
    const has = Object.values(colors).some(Boolean) || brandFont(f.heading) || brandFont(f.body) || text(b.company) || text(b.footer);
    if (has) {
      const logo = text(b.logo, 500);
      const brand = normalizeBrand({
        name: text(b.company, 80) ?? "My brand", isDefault: !listBrandsRaw().some((x) => x.isDefault),
        colors, fonts: { heading: f.heading, body: f.body }, company: b.company, author: b.author, footer: b.footer,
        notes: logo ? `Logo set before the brand library: ${logo}. Add it as this brand's logo.` : undefined,
        updatedAt: new Date().toISOString(),
      }, uniqueSlug(text(b.company, 80) ?? "my-brand"));
      if (brand) writeBrand(brand);
    }
  }
  renameSync(legacy, join(getLaxDir(), "office-theme.json.migrated"));
}

let migrated = false;

function listBrandsRaw(): Brand[] {
  if (!existsSync(brandsDir())) return [];
  return readdirSync(brandsDir())
    .map(readBrand)
    .filter((b): b is Brand => !!b)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A slug no saved brand uses yet. */
function uniqueSlug(name: string): string {
  let slug = brandSlug(name);
  for (let i = 2; existsSync(brandDir(slug)); i++) slug = `${brandSlug(name)}-${i}`;
  return slug;
}

/** Every saved brand, by name. */
export function listBrands(): Brand[] {
  if (!migrated) { migrated = true; try { migrateLegacyTheme(); } catch { /* the library still reads */ } }
  return listBrandsRaw();
}

/** Tests only: run the migration again on the next read. */
export function _resetBrandMigrationForTest(): void { migrated = false; }

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A brand by slug, name or alias, ignoring case. `bySlug: false` matches
 *  names only: a new brand called "acme" is not the renamed brand whose
 *  folder happens to be acme/. */
export function findBrand(ref: string, { bySlug = true } = {}): Brand | null {
  if (!ref.trim()) return null;
  return listBrands().find((b) => (bySlug && same(b.slug, ref)) || same(b.name, ref) || b.aliases.some((a) => same(a, ref))) ?? null;
}

export function defaultBrand(): Brand | null {
  return listBrands().find((b) => b.isDefault) ?? null;
}

/**
 * Create a brand or change one. Only the fields given change; a field given
 * as "" is cleared. Making a brand default makes every other one not.
 */
export function saveBrand(input: BrandInput, ref?: string): Brand {
  const existing = ref ? findBrand(ref) : input.name ? findBrand(input.name, { bySlug: false }) : null;
  if (ref && !existing) throw new Error(`No saved brand "${ref}".`);
  const name = text(input.name, 80) ?? existing?.name;
  if (!name) throw new Error("A new brand needs a name.");
  const slug = existing?.slug ?? uniqueSlug(name);
  const base = existing ?? normalizeBrand({ name }, slug)!;
  const merged = {
    ...base,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    name,
    colors: { ...base.colors, ...(input.colors ?? {}) },
    fonts: { ...base.fonts, ...(input.fonts ?? {}) },
    rules: { ...base.rules, ...(input.rules ?? {}) },
    assets: base.assets,
    updatedAt: new Date().toISOString(),
  };
  const brand = normalizeBrand(merged, slug);
  if (!brand) throw new Error("That brand could not be saved.");
  if (brand.isDefault) for (const other of listBrands()) if (other.slug !== slug && other.isDefault) writeBrand({ ...other, isDefault: false });
  writeBrand(brand);
  return brand;
}
