// The skin library over HTTP, for Settings → Appearance → My themes
// (public/js/settings-skins.js) and the layer that paints a skin
// (public/js/skin.js).
//
// GET  /api/skins                    → { skins: Skin[], active: slug | "", effects: string[] }
// POST /api/skins/save               { ref?, skin: { name, colors, fit, opacity, blur, dim, effect } }
// POST /api/skins/background         { skin, upload: "/uploads/<file>", name }  — copies a file the page uploaded
// POST /api/skins/remove-background  { skin }
// POST /api/skins/remove             { skin }
//
// Which skin is on is the `skin` setting, saved through POST /api/settings
// like the palette. Files arrive through the ordinary /api/upload (its size,
// type and magic checks) and are copied into the skin's own folder. The agent
// edits the same library through its `skin` tool; this route is the user's,
// so the agent principal is refused. Every change broadcasts
// settings_changed { skins: true }.

import { basename } from "node:path";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";
import { applySettings } from "../settings-apply.js";
import { loadSettings } from "../settings.js";
import { SKIN_BUILTIN_EFFECTS, findSkin, listSkins, saveSkin, type SkinInput } from "../skins/skin-store.js";
import { clearSkinBackground, removeSkin, setSkinBackground } from "../skins/skin-files.js";
import { uploadedFile } from "./brands.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The skin that is on, or "" when it is the built-in look (or the skin is gone). */
export function activeSkinSlug(): string {
  const slug = str((loadSettings() as Record<string, unknown>).skin);
  return slug && findSkin(slug)?.slug === slug ? slug : "";
}

/** The fields the page may set: everything but the files, which have their own calls. */
function inputOf(raw: unknown): SkinInput {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const pick = ["name", "colors", "fit", "opacity", "blur", "dim", "effect"] as const;
  return Object.fromEntries(pick.filter((k) => k in r).map((k) => [k, r[k]])) as SkinInput;
}

export const handleSkinRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  if (url.pathname !== "/api/skins" && !url.pathname.startsWith("/api/skins/")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (role === "agent") { json(403, { error: "Themes are edited by the user in Settings; the agent uses its skin tool." }); return true; }

  if (method === "GET" && url.pathname === "/api/skins") {
    json(200, { skins: listSkins(), active: activeSkinSlug(), effects: [...SKIN_BUILTIN_EFFECTS] });
    return true;
  }
  if (method !== "POST") return false;
  if (role !== "operator" && role !== "user") { json(403, { error: "Changing themes requires operator or user role" }); return true; }
  const body = await safeParseBody(req);
  if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
  const changed = (data: Record<string, unknown>) => {
    ctx.broadcastAll({ type: "settings_changed", settings: { skins: true } });
    json(200, { ok: true, ...data });
  };

  try {
    if (url.pathname === "/api/skins/save") {
      changed({ skin: saveSkin(inputOf(body.skin), str(body.ref) || undefined) });
      return true;
    }
    const skin = findSkin(str(body.skin));
    if (!skin) { json(404, { error: `No saved theme "${str(body.skin)}".` }); return true; }
    if (url.pathname === "/api/skins/background") {
      const data = uploadedFile(str(body.upload));
      if (!data) { json(400, { error: "Upload the file first." }); return true; }
      changed({ skin: await setSkinBackground(skin.slug, { name: basename(str(body.name) || "file"), data }) });
      return true;
    }
    if (url.pathname === "/api/skins/remove-background") { changed({ skin: await clearSkinBackground(skin.slug) }); return true; }
    if (url.pathname === "/api/skins/remove") {
      const wasOn = activeSkinSlug() === skin.slug;
      await removeSkin(skin.slug);
      // The window goes back to the built-in look, here and in every open tab.
      if (wasOn) await applySettings({ skin: "" });
      changed({ removed: skin.name });
      return true;
    }
  } catch (e) {
    json(400, { error: (e as Error).message });
    return true;
  }
  return false;
};
