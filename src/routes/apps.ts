import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody, corsHeaders } from "../server-utils.js";
import { renderApp } from "../app-renderer/index.js";
import type { AppDefinition } from "../app-runtime/index.js";

import { createLogger } from "../logger.js";
const logger = createLogger("routes.apps");

export const handleAppRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const appReg = ctx.appRegistry;
  const appPath = url.pathname.replace(/^\/api\/dashboards/, "/api/apps").replace(/^\/dashboards\//, "/apps/");

  if (method === "GET" && appPath === "/api/apps") {
    const port = ctx.config.port || 7007;
    const registered = appReg.list().map((d: AppDefinition) => ({
      id: d.id, name: d.name, description: d.description,
      components: d.components.length, layout: d.layout.type,
      url: `http://127.0.0.1:${port}/apps/${d.id}`,
      updatedAt: d.updatedAt, status: d.status, version: d.version,
      visibility: d.permissions?.visibility || "team",
    }));
    // Also scan workspace/apps/ for HTML apps not in the registry
    const registeredIds = new Set(registered.map(a => a.id));
    const wsAppsDir = resolve(ctx.config.workspace, "apps");
    if (existsSync(wsAppsDir)) {
      try {
        for (const d of readdirSync(wsAppsDir, { withFileTypes: true })) {
          if (!d.isDirectory() || d.name === "_audit" || registeredIds.has(d.name)) continue;
          const indexPath = join(wsAppsDir, d.name, "index.html");
          if (!existsSync(indexPath)) continue;
          const st = statSync(indexPath);
          registered.push({
            id: d.name, name: d.name.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
            description: "HTML app", components: 1, layout: "custom",
            url: `http://127.0.0.1:${port}/apps/${d.name}/index.html`,
            updatedAt: st.mtimeMs, status: "active", version: 1, visibility: "team",
          });
        }
      } catch (e) { logger.warn("[apps] workspace scan error:", (e as Error).message); }
    }
    json(200, registered);
    return true;
  }

  // Serve rendered app HTML (from AppRegistry — SAX-native app definitions)
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
    // Validate id shape to prevent path traversal — only alphanumeric + - _
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) { json(400, { error: "Invalid app id" }); return true; }
    const registryResult = appReg.delete(id);
    // ALSO remove the workspace folder so the app disappears from both
    // sources. Registry-only delete left /apps/<id> still scannable via
    // the workspace walk in GET /api/apps — the app would reappear on
    // next loadApps(). For workspace-only HTML apps (no registry entry),
    // this was the only thing keeping them alive.
    const wsDir = resolve(ctx.config.workspace, "apps", id);
    const relCheck = wsDir.startsWith(resolve(ctx.config.workspace, "apps"));
    let workspaceDeleted = false;
    if (relCheck && existsSync(wsDir)) {
      try {
        const { rmSync } = await import("node:fs");
        rmSync(wsDir, { recursive: true, force: true });
        workspaceDeleted = true;
        // Eager tombstone — write the delete intent into the synced
        // tombstone store NOW so a restart-before-push followed by
        // a pull doesn't resurrect this app from the remote.
        try {
          const { getLaxDir } = await import("../lax-data-dir.js");
          const { tombstoneAppEagerly } = await import("../sync/tombstones.js");
          const syncDir = join(getLaxDir(), "sync-repo");
          if (existsSync(syncDir)) tombstoneAppEagerly(syncDir, id);
        } catch (e) {
          logger.warn(`[apps] eager tombstone write failed for ${id}: ${(e as Error).message}`);
        }
      } catch (e) { logger.warn(`[apps] workspace delete failed for ${id}:`, (e as Error).message); }
    }
    if (!registryResult.deleted && !workspaceDeleted) {
      json(404, { error: "Not found" });
      return true;
    }
    try { ctx.agentSync.notifyChange(`app-delete:${id}`); } catch {}
    json(200, { ok: true, registry: registryResult.deleted, workspace: workspaceDeleted });
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

    // Update any sidebar pin that pointed at /apps/<oldId>/
    try {
      const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
      const settingsPath = join(ctx.dataDir, "settings.json");
      if (existsSync(settingsPath)) {
        const s = JSON.parse(rf(settingsPath, "utf-8"));
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
          wf(settingsPath, JSON.stringify(s, null, 2), { encoding: "utf-8", mode: 0o600 });
          try { const { broadcastAll } = await import("../chat-ws/index.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}
        }
      }
    } catch (e) { logger.warn(`[apps] pin update after rename failed: ${(e as Error).message}`); }

    json(200, { ok: true, id: newId, name: displayName, renamed: true }); return true;
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
    const updated = appReg.updateComponentValues(id, (body.values || body) as Record<string, unknown>);
    if (updated.error) { json(updated.state ? 429 : 404, { error: updated.error }); return true; }
    ctx.broadcastAll({ type: "app:state", appId: id });
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

  // Workspace root file listing/management (operates on workspace/ root,
  // distinct from the /api/apps/<id>/files endpoints above which target
  // workspace/apps/<id>/).
  const WS_FILE_EXTS = new Set(["pptx", "docx", "xlsx", "pdf", "txt", "md", "csv"]);
  const wsRoot = resolve(ctx.config.workspace);

  if (method === "GET" && url.pathname === "/api/workspace/files") {
    const extParam = url.searchParams.get("ext") || "";
    const exts = new Set(extParam.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
    if (!existsSync(wsRoot)) { json(200, []); return true; }
    try {
      const out: Array<{ name: string; size: number; mtime: number; url: string }> = [];
      for (const entry of readdirSync(wsRoot, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        const dot = entry.name.lastIndexOf(".");
        const ext = dot >= 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
        if (exts.size && !exts.has(ext)) continue;
        const st = statSync(join(wsRoot, entry.name));
        out.push({
          name: entry.name, size: st.size, mtime: st.mtimeMs,
          url: `/files/${encodeURIComponent(entry.name)}`,
        });
      }
      out.sort((a, b) => b.mtime - a.mtime);
      json(200, out);
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  const wsRenameMatch = url.pathname.match(/^\/api\/workspace\/files\/(.+)\/rename$/);
  if (method === "POST" && wsRenameMatch) {
    const oldName = decodeURIComponent(wsRenameMatch[1]);
    const body = await safeParseBody(req);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      json(400, { error: "name required" }); return true;
    }
    const newName = body.name.trim();
    for (const n of [oldName, newName]) {
      if (!n || n.startsWith(".") || n.includes("/") || n.includes("\\") || n.includes("..")) {
        json(400, { error: "Invalid filename" }); return true;
      }
    }
    const oldDot = oldName.lastIndexOf(".");
    const newDot = newName.lastIndexOf(".");
    const oldExt = oldDot >= 0 ? oldName.slice(oldDot + 1).toLowerCase() : "";
    const newExt = newDot >= 0 ? newName.slice(newDot + 1).toLowerCase() : "";
    if (!WS_FILE_EXTS.has(oldExt) || !WS_FILE_EXTS.has(newExt)) {
      json(400, { error: "Extension not allowed" }); return true;
    }
    if (oldExt !== newExt) { json(400, { error: "Extension must match" }); return true; }
    const oldPath = resolve(wsRoot, oldName);
    const newPath = resolve(wsRoot, newName);
    if (!oldPath.startsWith(wsRoot) || !newPath.startsWith(wsRoot)) {
      json(403, { error: "Path traversal blocked" }); return true;
    }
    if (!existsSync(oldPath)) { json(404, { error: "File not found" }); return true; }
    if (existsSync(newPath)) { json(409, { error: "Target already exists" }); return true; }
    try {
      const { renameSync } = await import("node:fs");
      renameSync(oldPath, newPath);
      json(200, { ok: true, name: newName });
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  const wsDeleteMatch = url.pathname.match(/^\/api\/workspace\/files\/([^/]+)$/);
  if (method === "DELETE" && wsDeleteMatch) {
    const name = decodeURIComponent(wsDeleteMatch[1]);
    if (!name || name.startsWith(".") || name.includes("/") || name.includes("\\") || name.includes("..")) {
      json(400, { error: "Invalid filename" }); return true;
    }
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (!WS_FILE_EXTS.has(ext)) { json(400, { error: "Extension not allowed" }); return true; }
    const filePath = resolve(wsRoot, name);
    if (!filePath.startsWith(wsRoot)) { json(403, { error: "Path traversal blocked" }); return true; }
    if (!existsSync(filePath)) { json(404, { error: "File not found" }); return true; }
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(filePath);
      json(200, { ok: true });
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  // Per-turn snapshot routes — IDE topbar ↺ Revert dropdown.
  const { handleAppSnapshotsRoutes } = await import("./apps-snapshots.js");
  if (await handleAppSnapshotsRoutes(method, appPath, req, res, json, ctx.config.workspace)) return true;

  // Read a single file from a workspace app directory
  const fileMatch = appPath.match(/^\/api\/apps\/([a-zA-Z0-9_-]+)\/files\/(.+)$/);
  if (method === "GET" && fileMatch) {
    const id = fileMatch[1];
    const filename = decodeURIComponent(fileMatch[2]);
    const appDir = resolve(ctx.config.workspace, "apps", id);
    const filePath = resolve(appDir, filename);
    // Path traversal check
    if (!filePath.startsWith(appDir)) { json(403, { error: "Path traversal blocked" }); return true; }
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
