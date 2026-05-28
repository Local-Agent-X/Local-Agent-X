import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { IntegrationRegistry } from "../../integrations/index.js";

export const handleIntegrationsRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/integrations") {
    json(200, ctx.integrations.list()); return true;
  }
  if (method === "GET" && url.pathname === "/api/integrations/schema") {
    json(200, { schema: IntegrationRegistry.getIntegrationSchema() }); return true;
  }
  if (method === "GET" && url.pathname.startsWith("/api/integrations/") && !url.pathname.includes("install") && !url.pathname.includes("uninstall") && !url.pathname.includes("toggle") && !url.pathname.includes("test") && !url.pathname.includes("schema")) {
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    const config = ctx.integrations.get(id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    json(200, config); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/install") {
    const body = await safeParseBody(req) as { id: string; secretValue?: string };
    const config = ctx.integrations.get(body.id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    if (body.secretValue) ctx.secretsStore.set(config.secretName, body.secretValue, config.name);
    ctx.integrations.markInstalled(body.id, true);
    json(200, { ok: true, id: body.id, secretName: config.secretName }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/uninstall") {
    const body = await safeParseBody(req) as { id: string };
    const config = ctx.integrations.get(body.id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    ctx.secretsStore.delete(config.secretName);
    ctx.integrations.markInstalled(body.id, false);
    json(200, { ok: true, id: body.id }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/toggle") {
    const body = await safeParseBody(req) as { id: string; enabled: boolean };
    ctx.integrations.setEnabled(body.id, body.enabled);
    json(200, { ok: true, id: body.id, enabled: body.enabled }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    if (!body.id || !body.name || !body.baseUrl) { json(400, { error: "id, name, and baseUrl are required" }); return true; }
    body.builtin = false; body.installed = false; body.enabled = true;
    if (!body.endpoints) body.endpoints = [];
    if (!body.headers) body.headers = {};
    ctx.integrations.addIntegration(body as unknown as import("../../integrations/index.js").IntegrationConfig);
    json(200, { ok: true, id: body.id }); return true;
  }
  if (method === "DELETE" && url.pathname.startsWith("/api/integrations/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) { json(400, { error: "Invalid integration ID" }); return true; }
    const removed = ctx.integrations.removeIntegration(id);
    if (!removed) { json(400, { error: "Cannot delete built-in integration" }); return true; }
    json(200, { ok: true, deleted: id }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/test") {
    const body = await safeParseBody(req) as { id: string };
    const config = ctx.integrations.get(body.id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    const token = ctx.secretsStore.get(config.secretName);
    if (!token) { json(400, { error: `No credentials found. Save your ${config.secretName} first.` }); return true; }
    try {
      let testUrl: string;
      const headers: Record<string, string> = { ...config.headers };
      if (config.id === "google" && config.authType === "api_key") {
        testUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&maxResults=1`;
        headers["X-Goog-Api-Key"] = token;
      } else {
        const testEndpoint = config.endpoints.find(e => e.method === "GET") || config.endpoints[0];
        testUrl = config.baseUrl + (testEndpoint?.path?.replace(/\{[^}]+\}/g, "") || "");
        headers["Authorization"] = `Bearer ${token}`;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(testUrl, { headers, signal: controller.signal });
      clearTimeout(timeout);
      json(200, { ok: r.ok, status: r.status, statusText: r.statusText });
    } catch (e) { json(200, { ok: false, error: (e as Error).message }); }
    return true;
  }

  return false;
};
