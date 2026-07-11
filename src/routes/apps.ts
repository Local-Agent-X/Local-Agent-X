import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody, corsHeaders } from "../server-utils.js";
import { confineToDir } from "../security/layer/index.js";
import { renderApp } from "../app-renderer/index.js";
import { loadSettings, reloadSettings, saveSettings } from "../settings.js";
import { readDevServerRecord, registerDevServer, listDevServerRecords } from "../tools/dev-server.js";
import { buildAppList } from "./apps-list.js";

import { createLogger } from "../logger.js";
const logger = createLogger("routes.apps");

export const handleAppRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const appReg = ctx.appRegistry;
  const appPath = url.pathname.replace(/^\/api\/dashboards/, "/api/apps").replace(/^\/dashboards\//, "/apps/");

  if (method === "GET" && appPath === "/api/apps") {
    const port = ctx.config.port || 7007;
    const wsAppsDir = resolve(ctx.config.workspace, "apps");
    const pins = (loadSettings().sidebarPins || []) as Array<{ name: string; icon: string; url: string }>;
    const list = buildAppList({
      listRegistry: () => appReg.list(),
      hasDevServer: (id) => !!readDevServerRecord(id),
      listDevServers: () => listDevServerRecords(),
      pins, wsAppsDir, port, now: () => Date.now(),
    });
    json(200, list);
    return true;
  }

  // Serve rendered app HTML (from AppRegistry — LAX-native app definitions)
  const appMatch = url.pathname.match(/^\/(apps|dashboards)\/([a-zA-Z0-9_-]+)\/?$/);
  if (method === "GET" && appMatch) {
    const appId = appMatch[2];
    // Prefer a custom HTML file in workspace/apps/<id>/index.html when
    // present. Agents often register a generic AppRegistry entry AND write
    // a custom themed index.html — the custom file is what the user built
    // and expects to see. Without this check, the editor shows the themed
    // HTML (iframe of the raw file) but the /apps/<id> URL renders the
    // generic component template, and the user sees two different apps.
    const customHtml = resolve(ctx.config.workspace, "apps", appId, "index.html");
    if (existsSync(customHtml)) return false;  // let the static handler serve it

    const def = appReg.get(appId);
    if (!def) {
      // Not a registered app either — fall through so the static-file handler
      // in server.ts can try other paths under /apps/<id>/.
      return false;
    }
    if (def.status === "suspended") { json(403, { error: "App is suspended" }); return true; }
    const html = renderApp(def, ctx.config.port || 7007);
    const cspHeaders: Record<string, string> = {
      "Content-Type": "text/html", "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    };
    res.writeHead(200, { ...cspHeaders, ...(req ? corsHeaders(req) : {}) });
    res.end(html);
    return true;
  }

  if (method === "GET" && appPath.startsWith("/api/apps/") && appPath.split("/").length === 4) {
    const id = appPath.split("/")[3];
    const def = appReg.get(id);
    if (!def) { json(404, { error: "App not found" }); return true; }
    json(200, def); return true;
  }

  if (method === "DELETE" && appPath.startsWith("/api/apps/") && appPath.split("/").length === 4) {
    const id = appPath.split("/")[3];
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) { json(400, { error: "Invalid app id" }); return true; }
    const result = await appReg.delete(id, "user", { workspaceDir: ctx.config.workspace });
    if (!result.deleted) { json(404, { error: result.error || "Not found" }); return true; }
    try { ctx.agentSync.notifyChange(`app-delete:${id}`); } catch {}
    json(200, { ok: true, registry: result.registry, workspace: result.workspace });
    return true;
  }

  // Rename a workspace-only app (and update any sidebar pins pointing at it).
  // Registry-based apps (with a def.json in ~/.lax/apps/) aren't supported
  // yet — renaming their id requires rewriting the def file + audit refs
  // and AppRegistry.update() intentionally blocks id changes.
  if (method === "POST" && appPath.match(/^\/api\/apps\/[a-zA-Z0-9_-]+\/rename$/)) {
    const oldId = appPath.split("/")[3];
    const body = await safeParseBody(req);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      json(400, { error: "name required" }); return true;
    }
    if (appReg.get(oldId)) {
      json(400, { error: "Rename isn't supported for registered apps yet. Edit the display name in the IDE or delete + re-create." });
      return true;
    }
    const displayName = body.name.trim().slice(0, 80);
    const newId = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    if (!newId) { json(400, { error: "name produces empty slug — use letters/numbers" }); return true; }
    if (newId === oldId) { json(200, { ok: true, id: oldId, name: displayName, renamed: false }); return true; }

    const wsApps = resolve(ctx.config.workspace, "apps");
    const oldDir = resolve(wsApps, oldId);
    const newDir = resolve(wsApps, newId);
    if (!newDir.startsWith(wsApps)) { json(400, { error: "invalid new id" }); return true; }
    if (!existsSync(oldDir)) { json(404, { error: `No folder at workspace/apps/${oldId}` }); return true; }
    if (existsSync(newDir)) { json(409, { error: `An app named "${newId}" already exists` }); return true; }
    if (appReg.get(newId)) { json(409, { error: `Registry already has "${newId}"` }); return true; }

    try {
      const { renameSync } = await import("node:fs");
      renameSync(oldDir, newDir);
    } catch (e) { json(500, { error: `folder rename failed: ${(e as Error).message}` }); return true; }

    // Update any sidebar pin that pointed at /apps/<oldId>/. reloadSettings()
    // gives a fresh whole-object disk read; saveSettings() atomically rewrites
    // the WHOLE object (mode 0600) AND updates the loadSettings() cache that
    // /api/apps reads — coherent without a trailing reloadSettings().
    try {
      const s = reloadSettings();
      const pins = (s.sidebarPins || []) as Array<{ name: string; icon: string; url: string }>;
      let changed = false;
      for (const p of pins) {
        if (p.url === `/apps/${oldId}/` || p.url === `/apps/${oldId}`) {
          p.url = `/apps/${newId}/`;
          changed = true;
        }
      }
      if (changed) {
        s.sidebarPins = pins;
        saveSettings(s);
        try { const { broadcastAll } = await import("../chat-ws/index.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}
      }
    } catch (e) { logger.warn(`[apps] pin update after rename failed: ${(e as Error).message}`); }

    json(200, { ok: true, id: newId, name: displayName, renamed: true }); return true;
  }

  // Restart a Tier-1.5 backend dev server. Backend SOURCE edits don't take
  // effect until the dev server restarts (it stays live 15 min, so X-ing out
  // and reopening doesn't bounce it). registerDevServer reads the persisted
  // command/port/cwd and does a clean kill-then-restart, rewriting the record
  // with the fresh session — no stop+ensure race.
  if (method === "POST" && appPath.match(/^\/api\/apps\/[a-zA-Z0-9_-]+\/restart-backend$/)) {
    const id = appPath.split("/")[3];
    const rec = readDevServerRecord(id);
    if (!rec) { json(404, { error: "This app has no backend dev server to restart." }); return true; }
    const r = registerDevServer({ appId: id, command: rec.command, port: rec.port, cwd: rec.cwd || undefined });
    if (!r.ok) { json(500, { error: r.error }); return true; }
    json(200, { ok: true, port: r.port, restarted: r.restarted }); return true;
  }

  // App lifecycle
  if (method === "PATCH" && appPath.startsWith("/api/apps/") && appPath.split("/").length === 4) {
    const id = appPath.split("/")[3];
    const body = await safeParseBody(req);
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }
    if (body.status === "suspended") {
      const r = appReg.suspend(id); json(r.success ? 200 : 400, r.success ? { ok: true } : { error: r.error });
    } else if (body.status === "active") {
      const r = appReg.activate(id); json(r.success ? 200 : 400, r.success ? { ok: true } : { error: r.error });
    } else if (body.status === "archived") {
      const r = appReg.archive(id); json(r.success ? 200 : 400, r.success ? { ok: true } : { error: r.error });
    } else {
      json(400, { error: "Invalid status. Use: active, suspended, archived" });
    }
    return true;
  }

  // App state
  if (method === "GET" && appPath.match(/^\/api\/apps\/[^/]+\/state$/)) {
    const id = appPath.split("/")[3];
    const state = appReg.getState(id);
    if (!state) { json(404, { error: "App not found" }); return true; }
    json(200, state); return true;
  }

  if (method === "POST" && appPath.match(/^\/api\/apps\/[^/]+\/state$/)) {
    const id = appPath.split("/")[3];
    const body = await safeParseBody(req);
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }
    // Optional idempotency key: a phone replaying its offline action queue on
    // reconnect tags each merge with its local actionId so a re-sent action is
    // applied exactly once (state-store dedups via state.appliedActions). When
    // body carries an actionId, `values` must be the merge payload (not the
    // whole body), so the id isn't merged in as a component value.
    const actionId = typeof body.actionId === "string" ? body.actionId : undefined;
    const values = (body.values || (actionId ? {} : body)) as Record<string, unknown>;
    const updated = appReg.updateComponentValues(id, values, "user", actionId);
    if (updated.error) { json(updated.state ? 429 : 404, { error: updated.error }); return true; }
    if (!updated.duplicate) ctx.broadcastAll({ type: "app:state", appId: id });
    json(200, { ok: true, duplicate: updated.duplicate === true }); return true;
  }

  // Phone-side render-verify ingress: the capture core injected into tunneled
  // app HTML (error-pipe-inject.ts) posts runtime errors here; they feed the
  // same gate as the desktop preview's WS pipe. No-ops when no live op
  // touched this app.
  if (method === "POST" && appPath.match(/^\/api\/apps\/[a-zA-Z0-9_-]+\/runtime-error$/)) {
    const id = appPath.split("/")[3];
    const body = await safeParseBody(req);
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }
    const { handleAppRuntimeError } = await import("../chat-ws/ide-runtime-error.js");
    await handleAppRuntimeError(id, body);
    json(200, { ok: true }); return true;
  }

  // App events
  if (method === "POST" && appPath.match(/^\/api\/apps\/[^/]+\/events$/)) {
    const id = appPath.split("/")[3];
    const body = await safeParseBody(req);
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }
    const result = appReg.pushEvent(id, {
      appId: id, type: (body.type as string) || "unknown",
      sourceComponent: body.sourceComponent as string | undefined, data: body.data,
    });
    if (result.error) { json(429, { error: result.error }); return true; }
    ctx.broadcastAll({ type: "app:event", appId: id, event: result.event });
    json(200, result.event); return true;
  }

  if (method === "GET" && appPath.match(/^\/api\/apps\/[^/]+\/events$/)) {
    const id = appPath.split("/")[3];
    const since = url.searchParams.get("since") ? parseInt(url.searchParams.get("since")!, 10) : undefined;
    json(200, appReg.getEvents(id, since)); return true;
  }

  // Offline bundle — the path is under /api/apps, the narrow scope the broker
  // phone is held to (see broker-transport/device-paths.ts). Returns the app
  // HTML, an inlined asset manifest, and the live state snapshot so the phone can
  // run the app with the desktop unreachable (product flow 5). Built in
  // apps-bundle.ts to keep this file under the LOC cap.
  if (method === "GET" && appPath.match(/^\/api\/apps\/[a-zA-Z0-9_-]+\/bundle$/)) {
    const id = appPath.split("/")[3];
    // A client-only SPA is built to a fresh static dist/ on demand (and rebuilt
    // when the app was updated) so it runs offline on the phone; a full-stack /
    // SSR app that genuinely needs the desktop is blocked with a clear reason
    // rather than shipping a broken offline copy. See apps-bundle-prepare.ts.
    const { prepareOfflineBundle } = await import("./apps-bundle-prepare.js");
    const result = await prepareOfflineBundle(appReg, ctx.config.workspace, id, ctx.config.port || 7007);
    if (result.status === "not_found") { json(404, { error: "App not found" }); return true; }
    if (result.status === "blocked") { json(422, { error: result.reason, offlineCapable: false }); return true; }
    json(200, result.bundle); return true;
  }

  // App audit log
  if (method === "GET" && appPath.match(/^\/api\/apps\/[^/]+\/audit$/)) {
    const id = appPath.split("/")[3];
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
    json(200, appReg.getAuditLog(id, limit)); return true;
  }

  // Consume actions
  if (method === "POST" && appPath.match(/^\/api\/apps\/[^/]+\/actions\/consume$/)) {
    const id = appPath.split("/")[3];
    const body = await safeParseBody(req);
    if (!body || !Array.isArray(body.actionIds)) { json(400, { error: "actionIds array required" }); return true; }
    appReg.consumeActions(id, body.actionIds);
    json(200, { ok: true }); return true;
  }

  // List files in a workspace app directory
  const filesMatch = appPath.match(/^\/api\/apps\/([a-zA-Z0-9_-]+)\/files$/);
  if (method === "GET" && filesMatch) {
    const id = filesMatch[1];
    const appDir = resolve(ctx.config.workspace, "apps", id);
    if (!existsSync(appDir)) { json(404, { error: "App directory not found" }); return true; }
    try {
      const files: string[] = [];
      const scan = (dir: string, prefix: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const rel = prefix ? prefix + "/" + entry.name : entry.name;
          if (entry.isDirectory()) { scan(join(dir, entry.name), rel); }
          else { files.push(rel); }
        }
      };
      scan(appDir, "");
      json(200, files);
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  // Workspace-ROOT file listing/rename/delete (operates on workspace/ root,
  // distinct from the /api/apps/<id>/files endpoints above). Extracted to keep
  // this file under the LOC cap; mirrors the snapshots lazy-import below.
  const { handleWorkspaceFilesRoutes } = await import("./workspace-files.js");
  if (await handleWorkspaceFilesRoutes(method, url, req, res, json, ctx.config.workspace)) return true;

  // Per-turn snapshot routes — IDE topbar ↺ Revert dropdown.
  const { handleAppSnapshotsRoutes } = await import("./apps-snapshots.js");
  if (await handleAppSnapshotsRoutes(method, appPath, req, res, json, ctx.config.workspace)) return true;

  // Read a single file from a workspace app directory
  const fileMatch = appPath.match(/^\/api\/apps\/([a-zA-Z0-9_-]+)\/files\/(.+)$/);
  if (method === "GET" && fileMatch) {
    const id = fileMatch[1];
    const filename = decodeURIComponent(fileMatch[2]);
    const appDir = resolve(ctx.config.workspace, "apps", id);
    // Symlink-safe containment + sensitive-path refusal (a bare startsWith()
    // admitted sibling-prefix dirs and followed planted symlinks on read).
    const filePath = confineToDir(appDir, filename);
    if (!filePath) { json(403, { error: "Path traversal blocked" }); return true; }
    if (!existsSync(filePath)) { json(404, { error: "File not found" }); return true; }
    try {
      const content = readFileSync(filePath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...(req ? corsHeaders(req) : {}) });
      res.end(content);
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  return false;
};
