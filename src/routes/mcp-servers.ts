import { timingSafeEqual } from "node:crypto";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";
import { MCPManager } from "../mcp-client/index.js";
import type { MCPServerConfig } from "../mcp-client/types.js";
import { getRuntimeConfig } from "../config.js";

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function hasOperatorToken(req: import("node:http").IncomingMessage): boolean {
  const expected = getRuntimeConfig().authToken;
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || provided.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(provided), Buffer.from(expected)); } catch { return false; }
}

/**
 * MCP server management — backs the "MCP Servers" card in the Tools &
 * Integrations settings tab. Reads/writes ~/.lax/mcp.json via the MCPManager
 * singleton (same instance bootstrap-tools connected at boot), then reloads so
 * config changes apply to the live tool surface without a restart.
 *
 * This is the CLIENT side (LAX consuming external MCP servers). The internal
 * bridge endpoints (/api/mcp/tools, /api/mcp/call) live in routes/mcp.ts.
 */
export const handleMcpServerRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  if (!url.pathname.startsWith("/api/mcp/servers")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const mgr = MCPManager.getInstance(ctx.dataDir);

  if (method === "GET" && url.pathname === "/api/mcp/servers") {
    json(200, { servers: mgr.getServers(), execution: mgr.getExecutionCapability() });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/mcp/servers") {
    const body = await safeParseBody(req) as { name?: string; command?: string; args?: unknown; env?: unknown; executionMode?: unknown } | null;
    if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    const name = (body.name || "").trim();
    const command = (body.command || "").trim();
    if (!NAME_RE.test(name)) { json(400, { error: "Server name must be 1-64 chars: letters, digits, _ or -" }); return true; }
    if (!command) { json(400, { error: "Command is required" }); return true; }
    if (body.executionMode !== "sandboxed" && body.executionMode !== "trusted") {
      json(400, { error: "executionMode must be sandboxed or trusted" }); return true;
    }
    if (body.executionMode === "sandboxed" && !mgr.getExecutionCapability().sandboxSupported) {
      json(409, { error: "MCP child sandboxing is unavailable on this platform. Choose trusted only after reviewing the server code." }); return true;
    }
    if (mgr.getServers().some(s => s.name === name)) { json(409, { error: `A server named "${name}" already exists` }); return true; }

    const args = Array.isArray(body.args) ? body.args.filter(a => typeof a === "string") as string[] : [];
    const env: Record<string, string> = {};
    if (body.env && typeof body.env === "object") {
      for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
        if (typeof v === "string" && k.trim()) env[k.trim()] = v;
      }
    }
    const config: MCPServerConfig = { command, args, disabled: false, executionMode: body.executionMode };
    if (Object.keys(env).length > 0) config.env = env;
    mgr.addServer(name, config);
    await mgr.reload();
    json(200, { ok: true, name });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/mcp/servers/toggle") {
    const body = await safeParseBody(req) as { name?: string; disabled?: boolean } | null;
    if (body === null || !body.name) { json(400, { error: "name required" }); return true; }
    if (!mgr.setServerDisabled(body.name, !!body.disabled)) { json(404, { error: "Server not found" }); return true; }
    await mgr.reload();
    json(200, { ok: true, name: body.name, disabled: !!body.disabled });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/mcp/servers/trust") {
    if (!hasOperatorToken(req)) { json(403, { error: "Trusted MCP approval requires an authenticated Settings action" }); return true; }
    const body = await safeParseBody(req) as { name?: string; approved?: boolean } | null;
    if (body === null || !body.name || typeof body.approved !== "boolean") { json(400, { error: "name and approved are required" }); return true; }
    if (!mgr.setServerLocalTrust(body.name, body.approved)) { json(404, { error: "Trusted MCP server not found" }); return true; }
    await mgr.reload();
    ctx.broadcastAll({ type: "settings_changed", settings: { mcpServers: true } });
    json(200, { ok: true, name: body.name, approved: body.approved });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/mcp/servers/test") {
    const body = await safeParseBody(req) as { name?: string } | null;
    if (body === null || !body.name) { json(400, { error: "name required" }); return true; }
    json(200, await mgr.testServer(body.name));
    return true;
  }

  if (method === "DELETE" && url.pathname.startsWith("/api/mcp/servers/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/mcp/servers/".length));
    if (!NAME_RE.test(name)) { json(400, { error: "Invalid server name" }); return true; }
    mgr.removeServer(name);
    await mgr.reload();
    json(200, { ok: true, deleted: name });
    return true;
  }

  return false;
};
