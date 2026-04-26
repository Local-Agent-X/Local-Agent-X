import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";
import { generateFullSpec } from "../../api-docs.js";
import { PluginManager } from "../../plugin-system.js";

export const handlePluginsRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // API docs
  if (method === "GET" && url.pathname === "/api/docs") {
    json(200, generateFullSpec()); return true;
  }

  // Plugins
  if (method === "GET" && url.pathname === "/api/plugins") {
    json(200, new PluginManager().listPlugins()); return true;
  }
  if (method === "POST" && url.pathname === "/api/plugins/load") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    try { json(200, { ok: true, plugin: await new PluginManager().loadPlugin(String(body.path)) }); } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/plugins/unload") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    json(200, { ok: new PluginManager().unloadPlugin(String(body.id)) }); return true;
  }

  return false;
};
