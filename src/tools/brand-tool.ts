/**
 * The agent's door into the brand library (shared/brand-store.ts): when the
 * user says "for NutriShop docs always use these colors, here's the header",
 * the agent saves it here, where the Office tools apply it by code from then
 * on, instead of trying to remember it. The Settings page edits the same
 * library (routes/brands.ts).
 */
import { basename, extname } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { ok, err } from "./result-helpers.js";
import { resolveAgentPath, sessionIdOf } from "../workspace/paths.js";
import { readValidatedFile } from "../security/layer/index.js";
import {
  BRAND_COLOR_ROLES, BRAND_KINDS, findBrand, listBrands, saveBrand, type Brand, type BrandInput,
} from "./shared/brand-store.js";
import { BRAND_FILE_ROLES, addBrandFile, removeBrand, removeBrandFile, type BrandFileRole } from "./shared/brand-files.js";
import { OFFICE_TEMPLATE_EXT, suggestFromFile } from "./shared/brand-import.js";

const ACTIONS = ["list", "get", "save", "add_asset", "import", "remove_file", "remove"] as const;

/** One brand as the agent reads it. */
export function describeBrand(b: Brand): string {
  const colors = BRAND_COLOR_ROLES.filter((r) => b.colors[r]).map((r) => `${r} #${b.colors[r]}`).join(", ");
  const lines = [
    `${b.name}${b.isDefault ? " (default brand)" : ""}${b.aliases.length ? ` — also called ${b.aliases.join(", ")}` : ""}`,
    `Colors: ${colors || "none (the chosen design's colors are used)"}`,
    `Fonts: ${[b.fonts.heading && `headings ${b.fonts.heading}`, b.fonts.body && `body ${b.fonts.body}`].filter(Boolean).join(", ") || "none set"}`,
  ];
  if (b.company || b.footer || b.author) lines.push(`Company: ${b.company ?? "-"}; footer: ${b.footer ?? "-"}; author: ${b.author ?? "-"}`);
  const images = [b.logo && `logo ${b.logo}`, b.logoOnDark && `logo on dark ${b.logoOnDark}`, b.letterhead && `letterhead ${b.letterhead}`].filter(Boolean);
  lines.push(`Images: ${images.join(", ") || "none"}`);
  if (b.assets.length) lines.push(`Files: ${b.assets.map((a) => `${a.file} (${a.kind}${a.note ? `: ${a.note}` : ""})`).join(", ")}`);
  if (b.notes) lines.push(`Rules: ${b.notes}`);
  for (const k of BRAND_KINDS) if (b.rules[k]) lines.push(`Rules for ${k}: ${b.rules[k]}`);
  return lines.join("\n");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Tool args can arrive as JSON strings. */
const objArg = (v: unknown): Record<string, unknown> | undefined => {
  if (isObj(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("{")) { try { const p = JSON.parse(v); return isObj(p) ? p : undefined; } catch { return undefined; } }
  return undefined;
};

/** The fields a save call sets. */
function inputOf(args: Record<string, unknown>): BrandInput {
  const input: BrandInput = {};
  if (typeof args.new_name === "string") input.name = args.new_name;
  else if (typeof args.name === "string") input.name = args.name;
  if (Array.isArray(args.aliases)) input.aliases = args.aliases.filter((a): a is string => typeof a === "string");
  if (typeof args.default === "boolean") input.isDefault = args.default;
  const colors = objArg(args.colors), fonts = objArg(args.fonts), rules = objArg(args.rules);
  if (colors) input.colors = colors as Brand["colors"];
  if (fonts) input.fonts = fonts as Brand["fonts"];
  if (rules) input.rules = rules as Brand["rules"];
  for (const k of ["company", "author", "footer", "notes"] as const) if (typeof args[k] === "string") input[k] = args[k] as string;
  return input;
}

async function importInto(args: Record<string, unknown>, name: string): Promise<ToolResult> {
  const path = resolveAgentPath(String(args.path ?? ""), sessionIdOf(args));
  const data = readValidatedFile(path);
  const fileName = basename(path);
  const found = await suggestFromFile(data, fileName);
  const existing = findBrand(name);
  const brand = saveBrand({ name: existing?.name ?? name, colors: found.colors, fonts: found.fonts }, existing ? existing.name : undefined);
  const isTemplate = OFFICE_TEMPLATE_EXT.has(extname(fileName).toLowerCase());
  let kept = "";
  if (isTemplate) kept = (await addBrandFile(brand.name, { name: fileName, data }, "template", "the template its colors and fonts were read from")).file;
  else if (!brand.logo) kept = (await addBrandFile(brand.name, { name: fileName, data }, "logo")).file;
  const saved = findBrand(brand.name)!;
  return ok(
    `Read ${fileName}: colors ${found.found.map((c) => `#${c}`).join(", ") || "none"}; fonts ${[found.fonts.heading, found.fonts.body].filter(Boolean).join(", ") || "none"}.` +
    (kept ? ` Kept it in the brand as ${kept}.` : "") +
    `\nSaved:\n${describeBrand(saved)}\nShow the user the colors chosen; change them with save if they meant others.`,
    { brand: saved.name },
  );
}

async function run(args: Record<string, unknown>): Promise<ToolResult> {
  const action = String(args.action ?? "");
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (action === "list") {
    const brands = listBrands();
    if (!brands.length) return ok("No brands are saved yet. Save one with action \"save\".");
    return ok(brands.map(describeBrand).join("\n\n"), { brands: brands.map((b) => b.name) });
  }
  if (!name) return err(`action "${action}" needs the brand's name.`);
  if (action === "get") {
    const b = findBrand(name);
    return b ? ok(describeBrand(b)) : err(`No saved brand "${name}". Saved: ${listBrands().map((x) => x.name).join(", ") || "none"}.`);
  }
  if (action === "save") {
    const existing = findBrand(name);
    const brand = saveBrand(inputOf(args), existing ? existing.name : undefined);
    return ok(`${existing ? "Updated" : "Saved"} brand:\n${describeBrand(brand)}`, { brand: brand.name });
  }
  if (action === "add_asset") {
    const role = String(args.role ?? "") as BrandFileRole;
    if (!BRAND_FILE_ROLES.includes(role)) return err(`role must be one of ${BRAND_FILE_ROLES.join(", ")}.`);
    const path = resolveAgentPath(String(args.path ?? ""), sessionIdOf(args));
    const { brand, file } = await addBrandFile(name, { name: basename(path), data: readValidatedFile(path) }, role, typeof args.note === "string" ? args.note : undefined);
    return ok(`Added ${file} to ${brand.name} as its ${role.replace(/_/g, " ")}.\n${describeBrand(brand)}`, { brand: brand.name, file });
  }
  if (action === "import") return importInto(args, name);
  if (action === "remove_file") {
    const brand = await removeBrandFile(name, String(args.file ?? ""));
    return ok(`Removed ${args.file} from ${brand.name} (it is in the trash).`);
  }
  if (action === "remove") {
    const brand = await removeBrand(name);
    return ok(`Removed the ${brand.name} brand. Its folder is in the trash, where the user can restore it.`);
  }
  return err(`Unknown action "${action}". One of: ${ACTIONS.join(", ")}.`);
}

/** Open Settings pages redraw their Brands tab, as after a change made
 *  there (routes/brands.ts). Best-effort: no socket in a test. */
async function broadcastBrandsChanged(): Promise<void> {
  try {
    const { broadcastAll } = await import("../chat-ws/index.js");
    broadcastAll({ type: "settings_changed", settings: { brands: true } });
  } catch { /* the change is saved either way */ }
}

export const brandTool: ToolDefinition = {
  name: "brand",
  description:
    "The user's saved brands (companies' looks): colors, fonts, logo, letterhead, templates and rules. " +
    "Office files (decks, docs, PDFs, sheets) made for a brand are made in it by code. " +
    "When the user tells you how a company's documents should look or gives you its logo or template, save it here instead of remembering it. " +
    "Actions: list; get; save (create or change: colors {primary, secondary, accent, dark, light} as hex, fonts {heading, body}, " +
    "aliases, default, company, footer, author, notes, rules {deck, doc, pdf, sheet, email}); " +
    "add_asset (copy a file in: path + role logo | logo_on_dark | letterhead | template | reference | image); " +
    "import (read colors and fonts from an Office template or a logo image at path); remove_file (file); remove. " +
    "For a website's look, run extract_site_assets with brand_look:true first.",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      name: { type: "string", description: "The brand's name (to create, or the brand to act on)." },
      new_name: { type: "string", description: "(save) Rename the brand." },
      aliases: { type: "array", items: { type: "string" }, description: "(save) Other names the user calls it." },
      default: { type: "boolean", description: "(save) Apply to files that name no brand." },
      colors: { type: "object", description: "(save) Hex colors by role." },
      fonts: { type: "object", description: "(save) {heading, body} font names." },
      company: { type: "string" }, footer: { type: "string" }, author: { type: "string" },
      notes: { type: "string", description: "(save) Rules for everything in this brand." },
      rules: { type: "object", description: "(save) Rules per kind of file: deck, doc, pdf, sheet, email." },
      path: { type: "string", description: "(add_asset, import) The file to copy in or read." },
      role: { type: "string", enum: [...BRAND_FILE_ROLES], description: "(add_asset) What the file is." },
      note: { type: "string", description: "(add_asset) What a template or reference is for." },
      file: { type: "string", description: "(remove_file) The stored file name." },
    },
  },
  async execute(args) {
    try {
      const result = await run(args);
      if (!result.isError && !["list", "get"].includes(String(args.action))) await broadcastBrandsChanged();
      return result;
    }
    catch (e) { return err((e as Error).message); }
  },
};
