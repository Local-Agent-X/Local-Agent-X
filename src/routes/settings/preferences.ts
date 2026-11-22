import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RouteHandler } from "../../server-context.js";
import type { SidebarPin } from "../../chat-ws/frames.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { RUNTIME_SETTINGS, operatorOnlyRefusal, publicSchema, settingSpec } from "../../settings-schema.js";
import { applySettings } from "../../settings-apply.js";
import { isUserOwnedSetting, strictlyTightens } from "../../settings-change-direction.js";
import { loadSettings, saveSettings } from "../../settings.js";
import { getRuntimeConfig, patchConfigFile, readConfigFile } from "../../config.js";
import { unsafeWorkspaceReason } from "../../workspace/workspace-location.js";
import { levenshtein } from "../../edit-distance.js";

/**
 * Why a request without the operator token may not apply `body`, or null when
 * it may. Such a request is the agent's own self-call: it may change an
 * agent-owned setting, a user-owned one only in the direction that narrows it
 * (settings-change-direction.ts), and an operator-owned one never. Every key
 * in `body` is declared (the route refuses the rest first).
 */
export function agentSettingsRefusal(body: Record<string, unknown>): string | null {
  const operatorOnly = operatorOnlyRefusal(Object.keys(body));
  if (operatorOnly) return operatorOnly;
  const widening = Object.keys(body).flatMap((k) => {
    const spec = settingSpec(k);
    return spec && spec.owner !== "agent" && isUserOwnedSetting(k) && !strictlyTightens(k, body[k]) ? [spec] : [];
  });
  if (widening.length > 0) {
    const places = [...new Set(widening.map((s) => s.where))].join("; ");
    return `${widening.map((s) => s.field).join(", ")} can only be widened by the user (${places}). Use the \`setting\` tool, which asks the user to approve.`;
  }
  return null;
}

/**
 * True only when the request carries the real app auth token. The authenticated
 * UI always does; the agent's own self-calls carry the internal agent token
 * instead. Without it a request is held to agentSettingsRefusal — the
 * equivalent gate to the `setting` tool's approval prompt.
 */
function hasValidOperatorToken(req: IncomingMessage, authToken: string): boolean {
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !authToken || provided.length !== authToken.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(authToken));
  } catch {
    return false;
  }
}

/**
 * The fields read once at boot, written straight to config.json: the port
 * and the workspace save location. Runs AFTER the runtime save in the POST
 * handler: saveConfig merges the running config over the file, and the
 * running config still holds the old values, so a save that also changed a
 * live setting used to put the old port and workspace back (2026-11-01 audit).
 * Returns why a workspace location was refused, or null.
 */
function persistBootFields(dataDir: string, body: Record<string, unknown>): string | null {
  let workspaceRefused: string | null = null;
  // Port is special: lives in config.json (read at boot, env-overridable)
  // but never read via getRuntimeConfig() — separate persistence path.
  const configPath = join(dataDir, "config.json");
  if (body.port) patchConfigFile({ port: parseInt(String(body.port), 10) }, configPath);

  // Workspace save location: same persistence path as port — config.json,
  // honored at next boot. We deliberately do NOT touch ctx.config.workspace
  // live: the running server is still serving from (and holding open) the old
  // workspace, and loadConfig migrates + re-links the folder at the next boot,
  // once this app instance has exited. Validate by creating the directory;
  // persist the raw value the user entered (loadConfig resolves it). An
  // invalid path is dropped — the next GET re-syncs the box to reality. So is
  // a location no workspace may have (unsafeWorkspaceReason), which the next
  // boot would refuse anyway; the response says why.

  if (typeof body.workspace === "string" && body.workspace.trim()) {
    const wsPath = body.workspace.trim();
    workspaceRefused = unsafeWorkspaceReason(resolve(wsPath));
    let valid = workspaceRefused === null;
    try {
      const resolved = resolve(wsPath);
      if (!valid || (existsSync(resolved) && !statSync(resolved).isDirectory())) valid = false;
      else mkdirSync(resolved, { recursive: true });
    } catch { valid = false; }
    if (valid) patchConfigFile({ workspace: wsPath }, configPath);
  }
  return workspaceRefused;
}

export const handlePreferencesRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Settings CRUD — schema-driven runtime persistence.
  //
  // The POST body is a flat bag; we always persist it to settings.json
  // (UI cache), then for each field listed in RUNTIME_SETTINGS we ALSO
  // promote it to config.json + ctx.config so the server runtime reads
  // the same value the UI just set. Adding a new runtime-bound setting
  // is a single line in settings-schema.ts — no edits here.
  if (method === "POST" && url.pathname === "/api/settings") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    // Read + write through getRuntimeConfig(). The config disk-watcher's hot
    // reload updates that object in place (reloadRuntimeConfig), so it and
    // ctx.config are one object carrying any hand edit made directly in
    // config.json; persisting a separate snapshot would clobber that edit.
    const runtimeConfig = getRuntimeConfig();
    const undeclared = Object.keys(body).filter((k) => !settingSpec(k));
    if (undeclared.length > 0) {
      json(400, { error: `No such setting: ${undeclared.join(", ")}. GET /api/settings/schema lists every setting and who may change it.` });
      return true;
    }
    if (!hasValidOperatorToken(req, runtimeConfig.authToken)) {
      const refusal = agentSettingsRefusal(body);
      if (refusal) { json(403, { error: refusal }); return true; }
    }
    // settings.json, the running config + config.json for runtime fields, the
    // effects of a changed runtime field, and the broadcast to open tabs
    // (settings-apply.ts). A runtime value that fails its schema is dropped
    // silently — it keeps its old value and the next GET re-syncs the UI.
    await applySettings(body);
    // After the runtime save: it merges the running config over config.json,
    // and the running config still holds the old port and workspace.
    const workspaceRefused = persistBootFields(ctx.dataDir, body);

    json(200, workspaceRefused ? { ok: true, workspaceRefused } : { ok: true }); return true;
  }
  if (method === "GET" && url.pathname === "/api/settings") {
    const merged: Record<string, unknown> = { ...loadSettings() };
    // Overlay live runtime values for every schema-listed field. This is
    // what makes the source-of-truth refactor work: the UI sees what the
    // server actually uses, not whatever was last written to settings.json
    // (which could be stale if the runtime value was changed via profile
    // defaults, env vars, or any path that doesn't round-trip through here).
    const runtimeConfig = getRuntimeConfig();
    for (const field of RUNTIME_SETTINGS) {
      const live = (runtimeConfig as unknown as Record<string, unknown>)[field.field];
      if (live !== undefined) merged[field.field] = live;
    }
    // port + workspace live in config.json (not settings.json / RUNTIME_SETTINGS),
    // so the overlay above doesn't surface them — read them directly so Settings
    // shows the real, persisted (pending-restart) values, not the HTML defaults.
    const onDisk = readConfigFile(join(ctx.dataDir, "config.json"));
    if (onDisk.port !== undefined) merged.port = onDisk.port;
    if (onDisk.workspace !== undefined) merged.workspace = onDisk.workspace;
    // Capability, not a setting: tells the UI whether self_edit can exist on
    // this install (git checkout) so the Developer Mode card only renders
    // where flipping it could ever do anything. Packaged installs hide it.
    try {
      const { isGitCheckout } = await import("../../self-edit/agents-rules.js");
      merged.selfEditAvailable = isGitCheckout();
    } catch { merged.selfEditAvailable = false; }
    json(200, merged);
    return true;
  }

  // Schema introspection — returned to agents (and other clients) so they
  // can discover valid field names + enum values for /api/settings without
  // guessing. Live failure that motivated this 2026-05-19: agent guessed
  // `shellAccess` instead of `enableShell`, server accepted the merge,
  // agent claimed success. Fix is to make the canonical field list
  // queryable.
  if (method === "GET" && url.pathname === "/api/settings/schema") {
    json(200, { fields: publicSchema() });
    return true;
  }

  // ── Sidebar Pins ──
  // Dynamic sidebar items stored in settings.json — survive updates, agent-controllable
  if (method === "GET" && url.pathname === "/api/sidebar/pins") {
    const settings = loadSettings();
    json(200, { pins: settings.sidebarPins || [] });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/sidebar/pins") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    const { name, icon, url: pageUrl } = body as { name?: string; icon?: string; url?: string };
    if (!name || !pageUrl) { json(400, { error: "name and url required" }); return true; }

    // Validate /apps/<id>/ URLs match a real workspace folder. Agents have
    // slugified display names ('Sample To Do' -> 'sample-to-do') and ended
    // up with a pin that 404s because the actual folder is 'sample-todo-app'.
    // Fail fast with a helpful hint so the agent can retry with the right URL.
    const appUrlMatch = String(pageUrl).match(/^\/apps\/([a-zA-Z0-9_-]+)\/?$/);
    if (appUrlMatch) {
      const slug = appUrlMatch[1];
      const candidate = resolve(ctx.config.workspace, "apps", slug, "index.html");
      if (!existsSync(candidate)) {
        // Probe for near-matches so the agent can self-correct
        let hint = "";
        try {
          const appsDir = resolve(ctx.config.workspace, "apps");
          if (existsSync(appsDir)) {
            const dirs = readdirSync(appsDir).filter(d => existsSync(resolve(appsDir, d, "index.html")));
            const similar = dirs.filter(d => d.includes(slug) || slug.includes(d) || levenshtein(d, slug) <= 3);
            if (similar.length > 0) hint = ` Did you mean: ${similar.map(d => `/apps/${d}/`).join(", ")}?`;
            else if (dirs.length > 0) hint = ` Available apps: ${dirs.map(d => `/apps/${d}/`).join(", ")}`;
          }
        } catch {}
        json(400, { error: `No workspace app found for url ${pageUrl}.${hint}` });
        return true;
      }
    }

    const settings = { ...loadSettings() };
    const pins = (settings.sidebarPins || []) as Array<{ name: string; icon: string; url: string }>;
    if (pins.length >= 10 && !pins.some(p => p.name === name)) {
      json(400, { error: "Maximum 10 pinned apps. Unpin one first." }); return true;
    }
    // Don't duplicate
    if (!pins.some(p => p.name === name)) {
      pins.push({ name: String(name), icon: String(icon || "📌"), url: String(pageUrl) });
      settings.sidebarPins = pins;
      saveSettings(settings);
    }
    // Re-pinning is the "I changed my mind" signal — clear any tombstone
    // so a remote-pulled unpin doesn't immediately re-remove this pin.
    try {
      const { pinTombstonePaths, clearPinTombstone } = await import("../../sync/pin-tombstones.js");
      const { join: pjoin } = await import("node:path");
      const { getLaxDir } = await import("../../lax-data-dir.js");
      clearPinTombstone(pinTombstonePaths(ctx.dataDir, pjoin(getLaxDir(), "sync-repo")), String(name));
    } catch {}
    try { ctx.agentSync.notifyChange(`pin-add:${name}`); } catch {}
    try { const { broadcastAll } = await import("../../chat-ws/index.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}
    json(200, { ok: true, pins }); return true;
  }
  if (method === "DELETE" && url.pathname.startsWith("/api/sidebar/pins/")) {
    const pinName = decodeURIComponent(url.pathname.split("/").pop() || "");
    if (!pinName) { json(400, { error: "pin name required" }); return true; }
    const settings = { ...loadSettings() };
    const pins = ((settings.sidebarPins || []) as SidebarPin[]).filter(p => p.name !== pinName);
    settings.sidebarPins = pins;
    saveSettings(settings);
    // Write tombstone so a future pull from another machine that still
    // has this pin doesn't restore it. Tombstone also propagates via
    // sync-repo so other machines see the unpin on next pull.
    try {
      const { pinTombstonePaths, tombstonePin } = await import("../../sync/pin-tombstones.js");
      const { join: pjoin } = await import("node:path");
      const { getLaxDir } = await import("../../lax-data-dir.js");
      tombstonePin(pinTombstonePaths(ctx.dataDir, pjoin(getLaxDir(), "sync-repo")), pinName);
    } catch {}
    try { ctx.agentSync.notifyChange(`pin-remove:${pinName}`); } catch {}
    try { const { broadcastAll } = await import("../../chat-ws/index.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}
    json(200, { ok: true, pins }); return true;
  }

  // Custom pages
  if (method === "GET" && url.pathname === "/api/custom-pages") {
    const registryPath = join(ctx.dataDir, "custom-pages.json");
    try { if (existsSync(registryPath)) { json(200, JSON.parse(readFileSync(registryPath, "utf-8"))); } else { json(200, []); } } catch { json(200, []); }
    return true;
  }
  // Takes the page off the list and deletes no file. An older create_page put
  // these pages in the install's public/ folder, beside the app's own UI
  // (app.html, tasks.html, ...), so unlinking <name>.html there let any caller,
  // the agent included, delete the UI by naming it. Pages are workspace apps
  // now (tools/create-page-tool.ts), removed with the other apps.
  if (method === "DELETE" && url.pathname.startsWith("/api/custom-pages/")) {
    const pageName = url.pathname.split("/").pop() || "";
    if (!pageName || /[^a-zA-Z0-9_-]/.test(pageName)) { json(400, { error: "Invalid page name" }); return true; }
    const registryPath = join(ctx.dataDir, "custom-pages.json");
    let registry: Array<{ name: string }> = [];
    try { if (existsSync(registryPath)) registry = JSON.parse(readFileSync(registryPath, "utf-8")); } catch {}
    const kept = registry.filter(p => p.name !== pageName);
    if (kept.length === registry.length) { json(404, { error: `No custom page named ${pageName}` }); return true; }
    writeFileSync(registryPath, JSON.stringify(kept, null, 2), "utf-8");
    json(200, { ok: true, deleted: pageName }); return true;
  }

  return false;
};
