/**
 * A brand's own files: the logo, the logo for dark grounds, the letterhead,
 * and the templates and references the user keeps with it. Files are copied
 * into the brand's folder (brand-store.ts), never pointed at where they came
 * from, so a cleared uploads folder or a moved file never breaks a brand and
 * sync carries them to the user's other machines.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { writeValidatedFile } from "../../security/layer/index.js";
import { moveToTrash } from "../../safe-delete.js";
import { tombstoneEagerly } from "../../sync/tombstones.js";
import { brandDir, findBrand, writeBrand, type Brand, type BrandAssetKind } from "./brand-store.js";

/** Where a file goes in the brand: one of the three images the documents
 *  place, or a kept asset. */
export const BRAND_FILE_ROLES = ["logo", "logo_on_dark", "letterhead", "template", "reference", "image"] as const;
export type BrandFileRole = (typeof BRAND_FILE_ROLES)[number];

const IMAGE_ROLES = { logo: "logo", logo_on_dark: "logoOnDark", letterhead: "letterhead" } as const;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tif", ".tiff"]);
const TEMPLATE_EXT = new Set([".pptx", ".potx", ".docx", ".dotx", ".xlsx", ".xltx"]);
const REFERENCE_EXT = new Set([...TEMPLATE_EXT, ...IMAGE_EXT, ".pdf", ".txt", ".md"]);
/** Sync carries files up to 10 MB (sync/constants.ts MAX_FILE_SIZE). */
export const MAX_BRAND_FILE_BYTES = 10_000_000;

/** A file name that stays inside the brand folder and keeps its extension. */
function storedName(original: string, taken: Set<string>): string {
  const ext = extname(original).toLowerCase();
  const stem = original.slice(0, original.length - extname(original).length)
    .replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 80) || "file";
  let name = `${stem}${ext}`;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem}-${i}${ext}`;
  return name;
}

/** Office documents embed PNG, JPEG and GIF; anything else becomes PNG. */
async function placeableImage(data: Buffer, ext: string): Promise<{ data: Buffer; ext: string }> {
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif") return { data, ext };
  const sharp = (await import("sharp")).default;
  return { data: await sharp(data, { density: 300 }).png().toBuffer(), ext: ".png" };
}

/**
 * Copy a file into a brand. `name` is the file's original name (for its
 * extension and, for kept assets, its stored name). Returns the brand as
 * saved and the stored file name.
 */
export async function addBrandFile(
  ref: string, file: { name: string; data: Buffer }, role: BrandFileRole, note?: string,
): Promise<{ brand: Brand; file: string }> {
  const brand = findBrand(ref);
  if (!brand) throw new Error(`No saved brand "${ref}".`);
  if (file.data.length > MAX_BRAND_FILE_BYTES) throw new Error(`That file is ${Math.round(file.data.length / 1e6)} MB; a brand file can be up to 10 MB so it syncs.`);
  const ext = extname(file.name).toLowerCase();
  const dir = brandDir(brand.slug);
  mkdirSync(dir, { recursive: true });

  if (role in IMAGE_ROLES) {
    if (!IMAGE_EXT.has(ext)) throw new Error(`A ${role.replace(/_/g, " ")} must be an image (png, jpg, gif, webp or svg), not ${ext || "a file without an extension"}.`);
    const img = await placeableImage(file.data, ext);
    const name = `${role.replace(/_/g, "-")}${img.ext}`;
    // Replacing a logo of another type would leave the old one behind.
    for (const f of readdirSync(dir)) if (f.startsWith(`${role.replace(/_/g, "-")}.`) && f !== name) await moveToTrash(join(dir, f), `brand_file:${brand.slug}`);
    writeValidatedFile(join(dir, name), img.data);
    const saved = { ...brand, [IMAGE_ROLES[role as keyof typeof IMAGE_ROLES]]: name, updatedAt: new Date().toISOString() };
    writeBrand(saved);
    return { brand: saved, file: name };
  }

  const kind = role as BrandAssetKind;
  const allowed = kind === "template" ? TEMPLATE_EXT : kind === "image" ? IMAGE_EXT : REFERENCE_EXT;
  if (!allowed.has(ext)) throw new Error(`A ${kind} can be ${[...allowed].join(", ")}; not ${ext || "a file without an extension"}.`);
  const taken = new Set(readdirSync(dir).map((f) => f.toLowerCase()));
  const name = storedName(file.name, taken);
  writeValidatedFile(join(dir, name), file.data);
  const saved = {
    ...brand,
    assets: [...brand.assets, { file: name, kind, ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}) }],
    updatedAt: new Date().toISOString(),
  };
  writeBrand(saved);
  return { brand: saved, file: name };
}

/** Take one file out of a brand, to the trash. */
export async function removeBrandFile(ref: string, file: string): Promise<Brand> {
  const brand = findBrand(ref);
  if (!brand) throw new Error(`No saved brand "${ref}".`);
  const roleField = (["logo", "logoOnDark", "letterhead"] as const).find((k) => brand[k] === file);
  if (!roleField && !brand.assets.some((a) => a.file === file)) throw new Error(`Brand "${brand.name}" has no file "${file}".`);
  const path = join(brandDir(brand.slug), file);
  if (existsSync(path)) await moveToTrash(path, `brand_file:${brand.slug}`);
  const saved: Brand = {
    ...brand,
    ...(roleField ? { [roleField]: undefined } : {}),
    assets: brand.assets.filter((a) => a.file !== file),
    updatedAt: new Date().toISOString(),
  };
  writeBrand(saved);
  return saved;
}

/** Remove a whole brand: its folder goes to the trash (recoverable there),
 *  and a tombstone tells the user's other machines to drop their copy. */
export async function removeBrand(ref: string): Promise<Brand> {
  const brand = findBrand(ref);
  if (!brand) throw new Error(`No saved brand "${ref}".`);
  const trashed = await moveToTrash(brandDir(brand.slug), `brand_remove:${brand.slug}`);
  if (!trashed && existsSync(brandDir(brand.slug))) throw new Error(`Brand "${brand.name}" could not be moved to the trash.`);
  const syncDir = join(getLaxDir(), "sync-repo");
  try { if (existsSync(syncDir)) tombstoneEagerly(join(syncDir, ".tombstones", "brands"), brand.slug); }
  catch { /* the push-time snapshot diff writes it on the next sync */ }
  return brand;
}
