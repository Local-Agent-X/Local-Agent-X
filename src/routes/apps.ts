import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody, corsHeaders } from "../server-utils.js";
import { renderApp } from "../app-renderer.js";
import type { AppDefinition } from "../app-runtime.js";

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
      } catch (e) { console.warn("[apps] workspace scan error:", (e as Error).message); }
    }
    json(200, registered);
    return true;
  }

  // Serve rendered app HTML
  const appMatch = url.pathname.match(/^\/(apps|dashboards)\/([a-zA-Z0-9_-]+)\/?$/);
  if (method === "GET" && appMatch) {
    const def = appReg.get(appMatch[2]);
    if (!def) { json(404, { error: "App not found" }); return true; }
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
    const result = appReg.delete(id);
    json(result.deleted ? 200 : 404, result.deleted ? { ok: true } : { error: result.error || "Not found" }); return true;
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
