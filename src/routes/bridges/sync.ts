import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";

export const handleSyncRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/sync/status") {
    json(200, ctx.agentSync.getStatus()); return true;
  }
  if (method === "POST" && url.pathname === "/api/sync/configure") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    ctx.agentSync.saveConfig(body);
    ctx.agentSync.stopHeartbeat();
    ctx.agentSync.startHeartbeat();
    json(200, { ok: true }); return true;
  }
  if (method === "POST" && url.pathname === "/api/sync/push") {
    json(200, await ctx.agentSync.push()); return true;
  }
  if (method === "POST" && url.pathname === "/api/sync/pull") {
    json(200, await ctx.agentSync.pull()); return true;
  }

  return false;
};
