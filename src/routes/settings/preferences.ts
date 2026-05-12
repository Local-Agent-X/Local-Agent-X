import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";

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

  // Settings CRUD
  if (method === "POST" && url.pathname === "/api/settings") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    const settingsPath = join(ctx.dataDir, "settings.json");
    let existing: Record<string, unknown> = {};
    try { if (existsSync(settingsPath)) existing = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    const merged = { ...existing, ...body };
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
    // Broadcast setting changes to all connected browsers via WebSocket
    if (body.theme || body.provider || body.model) {
      try {
        const { broadcastAll } = await import("../../chat-ws.js");
        broadcastAll({ type: "settings_changed", settings: body });
      } catch {}
    }
    if (body.port) {
      const configPath = join(ctx.dataDir, "config.json");
      let cfg: Record<string, unknown> = {};
      try { if (existsSync(configPath)) cfg = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
      cfg.port = parseInt(String(body.port), 10);
      writeFileSync(configPath, JSON.stringify(cfg, null, 2), { encoding: "utf-8", mode: 0o600 });
    }
    // Browser mode persists to main config (read by the browser launcher via
    // getRuntimeConfig), not just settings.json. Update in-memory too so the
    // next browser launch picks it up without a server restart.
    if (body.browserMode === "isolated" || body.browserMode === "attach") {
      ctx.config.browserMode = body.browserMode;
      const { saveConfig } = await import("../../config.js");
      saveConfig(ctx.config);
    }
    // Bridge voice preference is read from runtime config by voice.ts
    // synthesize(); persist to config.json + update in-memory so the next
    // bridge reply picks the new chain order without a server restart.
    if (body.bridgeVoicePreference === "auto" || body.bridgeVoicePreference === "sovits"
        || body.bridgeVoicePreference === "chatterbox" || body.bridgeVoicePreference === "lite") {
      ctx.config.bridgeVoicePreference = body.bridgeVoicePreference;
      const { saveConfig } = await import("../../config.js");
      saveConfig(ctx.config);
    }
    json(200, { ok: true }); return true;
  }
  if (method === "GET" && url.pathname === "/api/settings") {
    const settingsPath = join(ctx.dataDir, "settings.json");
    try {
      if (existsSync(settingsPath)) { json(200, JSON.parse(readFileSync(settingsPath, "utf-8"))); }
      else { json(200, {}); }
    } catch { json(200, {}); }
    return true;
  }

  // ── Sidebar Pins ──
  // Dynamic sidebar items stored in settings.json — survive updates, agent-controllable
  if (method === "GET" && url.pathname === "/api/sidebar/pins") {
    const settingsPath = join(ctx.dataDir, "settings.json");
    try {
      const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
      json(200, { pins: settings.sidebarPins || [] });
    } catch { json(200, { pins: [] }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/sidebar/pins") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    const { name, icon, url: pageUrl } = body as { name?: string; icon?: string; url?: string };
    if (!name || !pageUrl) { json(400, { error: "name and url required" }); return true; }

    // Validate /apps/<id>/ URLs match a real workspace folder. Agents have
    // slugified display names ('Mario To Do' -> 'mario-to-do') and ended
    // up with a pin that 404s because the actual folder is 'mario-todo-app'.
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

    const settingsPath = join(ctx.dataDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    const pins = (settings.sidebarPins || []) as Array<{ name: string; icon: string; url: string }>;
    if (pins.length >= 10 && !pins.some(p => p.name === name)) {
      json(400, { error: "Maximum 10 pinned apps. Unpin one first." }); return true;
    }
    // Don't duplicate
    if (!pins.some(p => p.name === name)) {
      pins.push({ name: String(name), icon: String(icon || "📌"), url: String(pageUrl) });
      settings.sidebarPins = pins;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });
    }
    // Re-pinning is the "I changed my mind" signal — clear any tombstone
    // so a remote-pulled unpin doesn't immediately re-remove this pin.
    try {
      const { pinTombstonePaths, clearPinTombstone } = await import("../../sync/pin-tombstones.js");
      const { join: pjoin } = await import("node:path");
      const { homedir } = await import("node:os");
      clearPinTombstone(pinTombstonePaths(ctx.dataDir, pjoin(homedir(), ".lax", "sync-repo")), String(name));
    } catch {}
    try { ctx.agentSync.notifyChange(`pin-add:${name}`); } catch {}
    try { const { broadcastAll } = await import("../../chat-ws.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}
    json(200, { ok: true, pins }); return true;
  }
  if (method === "DELETE" && url.pathname.startsWith("/api/sidebar/pins/")) {
    const pinName = decodeURIComponent(url.pathname.split("/").pop() || "");
    if (!pinName) { json(400, { error: "pin name required" }); return true; }
    const settingsPath = join(ctx.dataDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    const pins = ((settings.sidebarPins || []) as Array<{ name: string }>).filter(p => p.name !== pinName);
    settings.sidebarPins = pins;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });
    // Write tombstone so a future pull from another machine that still
    // has this pin doesn't restore it. Tombstone also propagates via
    // sync-repo so other machines see the unpin on next pull.
    try {
      const { pinTombstonePaths, tombstonePin } = await import("../../sync/pin-tombstones.js");
      const { join: pjoin } = await import("node:path");
      const { homedir } = await import("node:os");
      tombstonePin(pinTombstonePaths(ctx.dataDir, pjoin(homedir(), ".lax", "sync-repo")), pinName);
    } catch {}
    try { ctx.agentSync.notifyChange(`pin-remove:${pinName}`); } catch {}
    try { const { broadcastAll } = await import("../../chat-ws.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}
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
