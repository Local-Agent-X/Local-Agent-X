import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";
import { generateFullSpec } from "../../api-docs.js";
import { pluginManager } from "../../plugin-system.js";

export const handlePluginsRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // API docs
  if (method === "GET" && url.pathname === "/api/docs") {
    json(200, generateFullSpec()); return true;
  }

  // Plugins
  if (method === "GET" && url.pathname === "/api/plugins") {
    json(200, pluginManager.listPlugins()); return true;
  }
  if (method === "POST" && url.pathname === "/api/plugins/load") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    try {
      const manifest = await pluginManager.loadPlugin(String(body.path));
      const plugin = pluginManager.getPluginStatus(manifest.id);
      ctx.broadcastAll({ type: "settings_changed", settings: { plugins: true } });
      json(200, { ok: true, plugin });
    } catch { json(400, { error: "Plugin load could not be completed" }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/plugins/unload") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    try {
      const id = String(body.id);
      if (!pluginManager.disablePlugin(id)) throw new Error(`Plugin "${id}" is not registered`);
      ctx.broadcastAll({ type: "settings_changed", settings: { plugins: true } });
      json(200, { ok: true });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/plugins/retry") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    try {
      const manifest = await pluginManager.retryPlugin(String(body.id));
      const plugin = pluginManager.getPluginStatus(manifest.id);
      ctx.broadcastAll({ type: "settings_changed", settings: { plugins: true } });
      json(200, { ok: true, plugin });
    } catch { json(400, { error: "Plugin retry could not be completed" }); }
    return true;
  }

  return false;
};
