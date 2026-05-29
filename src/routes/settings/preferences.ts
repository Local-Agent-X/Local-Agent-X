import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, atomicWriteFileSync } from "../../server-utils.js";
import { RUNTIME_SETTINGS, BROADCAST_KEYS, publicSchema } from "../../settings-schema.js";
import { loadSettings, saveSettings } from "../../settings.js";

/** Tiny edit-distance for 'did you mean' hints on sidebar pin 404s. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  const dp: number[] = Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[n];
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
    const merged = { ...loadSettings(), ...body };
    // Atomic write — same race as cron-service.saveJobs() pre-9ec343f.
    // Concurrent POST /api/settings from two clients was overwriting
    // each other's merges in a non-atomic read-modify-write sequence,
    // and a hot-reloader reading the file mid-write could JSON.parse-crash.
    saveSettings(merged);

    // Broadcast UI-sync fields (theme, provider, model) over WS so other
    // tabs/windows pick up the change without a reload.
    const broadcastBody: Record<string, unknown> = {};
    for (const key of Object.keys(body)) {
      if (BROADCAST_KEYS.has(key)) broadcastBody[key] = body[key];
    }
    if (Object.keys(broadcastBody).length > 0) {
      try {
        const { broadcastAll } = await import("../../chat-ws/index.js");
        broadcastAll({ type: "settings_changed", settings: broadcastBody });
      } catch {}
    }

    // Port is special: lives in config.json (read at boot, env-overridable)
    // but never read via getRuntimeConfig() — separate persistence path.
    if (body.port) {
      const configPath = join(ctx.dataDir, "config.json");
      let cfg: Record<string, unknown> = {};
      try { if (existsSync(configPath)) cfg = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
      cfg.port = parseInt(String(body.port), 10);
      atomicWriteFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    }

    // Runtime-bound fields: validate, then mirror into config.json + ctx.config
    // so getRuntimeConfig() returns the new value on the next read. Invalid
    // values are dropped silently — the field stays at its old runtime value
    // and the next GET will reflect that, so the UI re-syncs without us
    // needing a 400 round-trip path.
    let runtimeChanged = false;
    for (const field of RUNTIME_SETTINGS) {
      if (!(field.field in body)) continue;
      const parsed = field.validate.safeParse(body[field.field]);
      if (!parsed.success) continue;
      (ctx.config as unknown as Record<string, unknown>)[field.field] = parsed.data;
      runtimeChanged = true;
    }
    if (runtimeChanged) {
      const { saveConfig } = await import("../../config.js");
      saveConfig(ctx.config);
    }

    json(200, { ok: true }); return true;
  }
  if (method === "GET" && url.pathname === "/api/settings") {
    const merged: Record<string, unknown> = { ...loadSettings() };
    // Overlay live runtime values for every schema-listed field. This is
    // what makes the source-of-truth refactor work: the UI sees what the
    // server actually uses, not whatever was last written to settings.json
    // (which could be stale if the runtime value was changed via profile
    // defaults, env vars, or any path that doesn't round-trip through here).
    for (const field of RUNTIME_SETTINGS) {
      const live = (ctx.config as unknown as Record<string, unknown>)[field.field];
      if (live !== undefined) merged[field.field] = live;
    }
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
    const pins = ((settings.sidebarPins || []) as Array<{ name: string }>).filter(p => p.name !== pinName);
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
  if (method === "DELETE" && url.pathname.startsWith("/api/custom-pages/")) {
    const pageName = url.pathname.split("/").pop() || "";
    if (!pageName || /[^a-zA-Z0-9_-]/.test(pageName)) { json(400, { error: "Invalid page name" }); return true; }
    const registryPath = join(ctx.dataDir, "custom-pages.json");
    try {
      let registry: Array<{ name: string }> = [];
      if (existsSync(registryPath)) registry = JSON.parse(readFileSync(registryPath, "utf-8"));
      registry = registry.filter(p => p.name !== pageName);
      writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
    } catch {}
    const filePath = join(ctx.publicDir, `${pageName}.html`);
    try { const { unlinkSync } = await import("node:fs"); unlinkSync(filePath); } catch {}
    json(200, { ok: true, deleted: pageName }); return true;
  }

  return false;
};
