import type { RouteHandler } from "../server-context.js";
import { jsonResponse, readBody, safeErrorMessage } from "../server-utils.js";

/**
 * Internal MCP endpoints — consumed by src/mcp-bridge.ts subprocess,
 * which Claude CLI spawns when using the MCP config we generate.
 *
 * Flow:
 *   Claude CLI --mcp-config sax.json
 *     └─ spawns: node src/mcp-bridge.js
 *           └─ HTTP POST /api/mcp/tools   (list)
 *           └─ HTTP POST /api/mcp/call    (execute)
 *                 └─ runs in main SAX process with Ari + policy + approval
 */
export const handleMcpRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/mcp/tools") {
    const tools = ctx.allAgentTools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    }));
    json(200, { tools });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/mcp/call") {
    try {
      const body = JSON.parse(await readBody(req)) as { name: string; arguments?: Record<string, unknown>; sessionId?: string };
      if (!body.name) { json(400, { error: "name required" }); return true; }

      const tool = ctx.allAgentTools.find(t => t.name === body.name);
      if (!tool) { json(404, { error: `tool '${body.name}' not found` }); return true; }

      const args = body.arguments || {};
      const sessionId = body.sessionId || "mcp-bridge";

      // Run through the same path as other agent tool calls: security, policy,
      // RBAC, Ari all apply. Caller role is operator (MCP bridge is trusted —
      // only reachable on localhost, authed via SAX auth token).
      const { executeToolCalls } = await import("../tool-executor.js");
      const toolMap = new Map(ctx.allAgentTools.map(t => [t.name, t]));
      const results = await executeToolCalls(
        [{ id: `mcp-${Date.now()}`, name: body.name, arguments: JSON.stringify(args) }],
        toolMap,
        ctx.security,
        ctx.toolPolicy,
        undefined, // threatEngine
        ctx.rbac,
        "operator",
        sessionId,
        undefined, // onEvent
        undefined, // signal
      );

      const toolResult = results.find(r => r.role === "tool");
      const content = typeof toolResult?.content === "string" ? toolResult.content : JSON.stringify(toolResult?.content || "");

      // MCP expects content as an array of {type, text} blocks
      json(200, {
        content: [{ type: "text", text: content }],
        isError: content.startsWith("BLOCKED") || content.startsWith("Tool execution failed"),
      });
    } catch (e) {
      json(500, { error: safeErrorMessage(e) });
    }
    return true;
  }

  return false;
};
