/**
 * The skin library: the user's own looks for the app window. A skin is a
 * background picture or video, colors, how see-through the panels are, and a
 * moving layer (snow, rain, or an effect the agent wrote), applied to the chat
 * window and its sidebars by public/js/skin.js.
 *
 * One folder per skin under the data dir, `skins/<slug>/`: `skin.json` plus
 * its files (skin-files.ts). It is user data, never part of the app, so an
 * update cannot touch it; it syncs with the other brain folders
 * (sync/constants.ts BRAIN_DIRS) and a delete travels as a tombstone.
 *
 * Written by Settings → Appearance (routes/skins.ts) and by the agent's
 * `skin` tool. Which skin is on is the `skin` setting, not a field here.
 * The Settings page calls these "themes"; the code says skin because theme
 * already names the light/dark mode and a brand's Office look.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { brandHex } from "../tools/shared/brand-store.js";
import { untilContrast } from "../tools/shared/brand-colors.js";
import { contrastRatio } from "../tools/shared/slide-checks.js";

export const SKIN_COLOR_ROLES = ["bg", "surface", "text", "accent"] as const;
export type SkinColorRole = (typeof SKIN_COLOR_ROLES)[number];

export const SKIN_FITS = ["cover", "contain", "tile"] as const;
export type SkinFit = (typeof SKIN_FITS)[number];

/** The moving layers shipped with the app (public/js/skin-effects-builtin.js
 *  and phrase-rain.js register one each; skin-effects.test.ts holds the two
 *  lists together), plus "custom": the skin's own effect.js. */
export const SKIN_BUILTIN_EFFECTS = ["snow", "rain", "stars", "embers", "phrases"] as const;
export const SKIN_EFFECT_KINDS = [...SKIN_BUILTIN_EFFECTS, "custom"] as const;
export type SkinEffectKind = (typeof SKIN_EFFECT_KINDS)[number];

export interface SkinEffect {
  kind: SkinEffectKind;
  /** How many particles, how fast, how big: 1 is the effect's own default. */
  density: number;
  speed: number;
  size: number;
  /** Grows as the chat's context fills. */
  reactive: boolean;
}

export interface Skin {
  name: string;
  slug: string;
  colors: Partial<Record<SkinColorRole, string>>;
  /** File names inside the skin's folder. */
  background?: string;
  code?: string;
  fit: SkinFit;
  /** How solid the panels are over the background: 1 hides it, 0.15 nearly shows it all. */
  opacity: number;
  /** Background blur in px, and how far it fades toward the base color (0–0.9). */
  blur: number;
  dim: number;
  effect?: SkinEffect;
  updatedAt: string;
}

export type SkinInput = Partial<Omit<Skin, "slug" | "updatedAt" | "background" | "code" | "effect">> & {
  /** null turns the moving layer off. */
  effect?: Partial<SkinEffect> | null;
};

export const skinsDir = (): string => join(getLaxDir(), "skins");
export const skinDir = (slug: string): string => join(skinsDir(), slug);

/** Text must read on the panels it sits on; the accent only has to be seen. */
const TEXT_CONTRAST = 4.5;
const ACCENT_CONTRAST = 2;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
const fileName = (v: unknown): string | undefined =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(v) && !v.includes("..") ? v : undefined;

/** A folder-safe slug: lowercase letters, digits and dashes, at most 40. */
export function skinSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "theme";
}

/**
 * The colors as they may be applied. Text is kept only with a panel color to
 * read against (the built-in palette's panel changes with light and dark
 * mode), and is moved until it reads on it; so a skin can restyle the app
 * but never leave it unreadable, Settings included.
 */
function readableColors(raw: Record<string, unknown>): Skin["colors"] {
  const c: Skin["colors"] = {};
  for (const r of SKIN_COLOR_ROLES) { const h = brandHex(raw[r]); if (h) c[r] = h; }
  const panel = c.surface ?? c.bg;
  if (!panel) { delete c.text; return c; }
  const away = contrastRatio(panel, "000000") > contrastRatio(panel, "FFFFFF") ? "000000" : "FFFFFF";
  if (c.text) c.text = untilContrast(c.text, panel, TEXT_CONTRAST, away);
  if (c.accent) c.accent = untilContrast(c.accent, panel, ACCENT_CONTRAST, away);
  return c;
}

function normalizeEffect(raw: unknown): SkinEffect | undefined {
  if (!isObj(raw)) return undefined;
  const kind = SKIN_EFFECT_KINDS.find((k) => k === raw.kind);
  if (!kind) return undefined;
  return {
    kind,
    density: num(raw.density, 0.2, 3, 1), speed: num(raw.speed, 0.2, 3, 1), size: num(raw.size, 0.5, 3, 1),
    reactive: raw.reactive === true,
  };
}

/** Every field checked and clamped, so a hand-edited or synced skin.json can
 *  never put a path, a script or an unreadable color into the window. */
export function normalizeSkin(raw: unknown, slug: string): Skin | null {
  if (!isObj(raw)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 60) : "";
  if (!name) return null;
  return {
    name, slug,
    colors: readableColors(isObj(raw.colors) ? raw.colors : {}),
    background: fileName(raw.background),
    code: fileName(raw.code),
    fit: SKIN_FITS.find((f) => f === raw.fit) ?? "cover",
    opacity: num(raw.opacity, 0.15, 1, 0.8),
    blur: num(raw.blur, 0, 40, 0),
    dim: num(raw.dim, 0, 0.9, 0.2),
    effect: normalizeEffect(raw.effect),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
  };
}

function readSkin(slug: string): Skin | null {
  try { return normalizeSkin(JSON.parse(readFileSync(join(skinDir(slug), "skin.json"), "utf-8")), slug); }
  catch { return null; }
}

/** Write skin.json through a temp file, so a crash never leaves half a skin. */
export function writeSkin(s: Skin): void {
  const dir = skinDir(s.slug);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "skin.json.tmp");
  writeFileSync(tmp, JSON.stringify(s, null, 2), "utf-8");
  renameSync(tmp, join(dir, "skin.json"));
}

/** Every saved skin, by name. */
export function listSkins(): Skin[] {
  if (!existsSync(skinsDir())) return [];
  return readdirSync(skinsDir())
    .map(readSkin)
    .filter((s): s is Skin => !!s)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A skin by folder name or by name, ignoring case. */
export function findSkin(ref: string): Skin | null {
  if (!ref.trim()) return null;
  return listSkins().find((s) => same(s.slug, ref) || same(s.name, ref)) ?? null;
}

function uniqueSlug(name: string): string {
  let slug = skinSlug(name);
  for (let i = 2; existsSync(skinDir(slug)); i++) slug = `${skinSlug(name)}-${i}`;
  return slug;
}

/**
 * Create a skin or change one. Only the fields given change. Its files (the
 * background, the effect code) have their own calls in skin-files.ts.
 */
export function saveSkin(input: SkinInput, ref?: string): Skin {
  const existing = ref ? findSkin(ref) : input.name ? findSkin(input.name) : null;
  if (ref && !existing) throw new Error(`No saved theme "${ref}".`);
  const name = (typeof input.name === "string" && input.name.trim()) || existing?.name;
  if (!name) throw new Error("A new theme needs a name.");
  const slug = existing?.slug ?? uniqueSlug(name);
  const base = existing ?? normalizeSkin({ name }, slug)!;
  const { effect, ...fields } = input;
  const skin = normalizeSkin({
    ...base,
    ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
    name,
    colors: { ...base.colors, ...(input.colors ?? {}) },
    effect: effect === null ? undefined : effect ? { ...base.effect, ...effect } : base.effect,
    background: base.background,
    code: base.code,
    updatedAt: new Date().toISOString(),
  }, slug);
  if (!skin) throw new Error("That theme could not be saved.");
  if (skin.effect?.kind === "custom" && !skin.code) throw new Error("This theme has no effect code yet; write it first, then set the effect to custom.");
  writeSkin(skin);
  return skin;
}
