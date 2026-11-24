// The brand library over HTTP, for Settings → Brands (public/js/settings-brands.js).
//
// GET  /api/brands               → { brands: Brand[] }
// POST /api/brands/save          { ref?, brand: { name, aliases, isDefault, colors, fonts, company, footer, author, notes, rules } }
// POST /api/brands/file          { brand, upload: "/uploads/<file>", name, role, note? }  — copies a file the page uploaded
// POST /api/brands/remove-file   { brand, file }
// POST /api/brands/remove        { brand }
// POST /api/brands/import        { brand, upload, name } | { brand, url }  — reads colors and fonts in
//
// Files arrive through the ordinary /api/upload (its size, type and magic
// checks) and are copied out of uploads/ into the brand's own folder, so
// clearing uploads never breaks a brand. The agent edits the same library
// through its `brand` tool; this route is the user's, so the agent principal
// is refused. Every change broadcasts settings_changed { brands: true }.

import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";
import { uploadsDir } from "../config.js";
import { confineToDir } from "../security/layer/index.js";
import { findBrand, listBrands, saveBrand, type Brand, type BrandInput } from "../tools/shared/brand-store.js";
import { BRAND_FILE_ROLES, addBrandFile, removeBrand, removeBrandFile, type BrandFileRole } from "../tools/shared/brand-files.js";
import { suggestFromFile, type BrandSuggestion } from "../tools/shared/brand-import.js";
import { fetchLogo, readSiteBrand } from "../tools/site-brand.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A file /api/upload stored, by the address it returned. */
function uploaded(address: string): Buffer | null {
  const name = address.replace(/^\/uploads\//, "");
  if (!name || /[^a-zA-Z0-9._-]/.test(name)) return null;
  const file = confineToDir(uploadsDir(), name);
  return file && existsSync(file) ? readFileSync(file) : null;
}

/** The fields the page may set: everything but the files, which have their own calls. */
function inputOf(raw: unknown): BrandInput {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const pick = ["name", "aliases", "isDefault", "colors", "fonts", "company", "footer", "author", "notes", "rules"] as const;
  return Object.fromEntries(pick.filter((k) => k in r).map((k) => [k, r[k]])) as BrandInput;
}

/** Apply what an import found, and keep the template or logo it came from. */
async function applyImport(brand: Brand, found: BrandSuggestion, keep: { name: string; data: Buffer; role: BrandFileRole } | null): Promise<Brand> {
  let saved = saveBrand({ colors: found.colors, fonts: found.fonts }, brand.slug);
  if (keep) saved = (await addBrandFile(saved.slug, keep, keep.role, keep.role === "template" ? "the template its colors and fonts were read from" : undefined)).brand;
  return saved;
}

async function importInto(brand: Brand, body: Record<string, unknown>): Promise<{ brand: Brand; found: BrandSuggestion }> {
  const site = str(body.url).trim();
  if (site) {
    if (!/^https?:\/\//i.test(site)) throw new Error("The website address must start with http:// or https://.");
    const look = await readSiteBrand(site);
    let logo: { name: string; data: Buffer; role: BrandFileRole } | null = null;
    if (!brand.logo) {
      for (const u of look.logos) {
        const got = await fetchLogo(u);
        if (!got) continue;
        // A favicon (.ico) is not a logo an Office file can place.
        if (got.name.endsWith(".ico")) continue;
        logo = { ...got, role: "logo" };
        break;
      }
    }
    try { return { brand: await applyImport(brand, look, logo), found: look }; }
    catch { return { brand: await applyImport(brand, look, null), found: look }; }
  }
  const data = uploaded(str(body.upload));
  if (!data) throw new Error("Upload the file first.");
  const name = basename(str(body.name) || "file");
  const found = await suggestFromFile(data, name);
  const template = /\.(pptx|potx|docx|dotx|xlsx|xltx)$/i.test(name);
  return { brand: await applyImport(brand, found, template ? { name, data, role: "template" } : brand.logo ? null : { name, data, role: "logo" }), found };
}

export const handleBrandRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  if (url.pathname !== "/api/brands" && !url.pathname.startsWith("/api/brands/")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (role === "agent") { json(403, { error: "Brands are edited by the user in Settings; the agent uses its brand tool." }); return true; }

  if (method === "GET" && url.pathname === "/api/brands") { json(200, { brands: listBrands() }); return true; }
  if (method !== "POST") return false;
  if (role !== "operator" && role !== "user") { json(403, { error: "Changing brands requires operator or user role" }); return true; }
  const body = await safeParseBody(req);
  if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
  const changed = (data: Record<string, unknown>) => {
    ctx.broadcastAll({ type: "settings_changed", settings: { brands: true } });
    json(200, { ok: true, ...data });
  };

  try {
    if (url.pathname === "/api/brands/save") {
      const ref = str(body.ref) || undefined;
      changed({ brand: saveBrand(inputOf(body.brand), ref) });
      return true;
    }
    const brand = findBrand(str(body.brand));
    if (!brand) { json(404, { error: `No saved brand "${str(body.brand)}".` }); return true; }
    if (url.pathname === "/api/brands/file") {
      const roleArg = str(body.role) as BrandFileRole;
      if (!BRAND_FILE_ROLES.includes(roleArg)) { json(400, { error: `role must be one of ${BRAND_FILE_ROLES.join(", ")}` }); return true; }
      const data = uploaded(str(body.upload));
      if (!data) { json(400, { error: "Upload the file first." }); return true; }
      changed(await addBrandFile(brand.slug, { name: basename(str(body.name) || "file"), data }, roleArg, str(body.note) || undefined));
      return true;
    }
    if (url.pathname === "/api/brands/remove-file") { changed({ brand: await removeBrandFile(brand.slug, str(body.file)) }); return true; }
    if (url.pathname === "/api/brands/remove") { await removeBrand(brand.slug); changed({ removed: brand.name }); return true; }
    if (url.pathname === "/api/brands/import") { changed(await importInto(brand, body)); return true; }
  } catch (e) {
    json(400, { error: (e as Error).message });
    return true;
  }
  return false;
};

