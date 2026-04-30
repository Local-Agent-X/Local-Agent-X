import type { RouteHandler } from "../server-context.js";
import { jsonResponse, readBody, safeErrorMessage } from "../server-utils.js";

// Tools deliberately NOT exposed to the MCP bridge (= the chat supervisor
// running as claude CLI). These either block the supervisor's chat turn
// (preventing the user from replying while a worker runs) or duplicate a
// non-blocking variant the supervisor should use instead. Autopilot and
// scripted flows use these tools through the inline tool path; only the
// user-facing supervisor needs them hidden.
const MCP_HIDDEN_TOOLS = new Set<string>([
  "op_wait",      // blocks the chat turn — supervisor should let auto-notify surface results
  "op_submit",    // sugar = op_submit_async + op_wait, same blocking problem
  "agent_spawn",  // alternate delegation door — supervisor was using it to bypass op_submit_async dedup
  "delegate",     // generic delegate primitive — same bypass risk
  "agent_message",// reply-to-agent primitive used inside agency, not by user-facing supervisor
]);

function serializeMcpContent(results: Array<{ role: string; content: unknown }>): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  for (const result of results) {
    if (result.role === "tool") {
      const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content || "");
      blocks.push({ type: "text", text });
      continue;
    }

    if (result.role !== "user" || !Array.isArray(result.content)) continue;

    for (const part of result.content as Array<Record<string, unknown>>) {
      if (part.type === "text" && typeof part.text === "string") {
        blocks.push({ type: "text", text: part.text });
        continue;
      }

      if (part.type !== "image_url") continue;
      const imageUrl = part.image_url as { url?: string } | undefined;
      const match = imageUrl?.url?.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) continue;
      blocks.push({
        type: "image",
        mimeType: match[1],
        data: match[2],
      });
    }
  }

  return blocks;
}

/**
 * Internal MCP endpoints — consumed by src/mcp-bridge.ts subprocess,
 * which Claude CLI spawns when using the MCP config we generate.
 *
 * Flow:
 *   Claude CLI --mcp-config lax.json
 *     └─ spawns: node src/mcp-bridge.js
 *           └─ HTTP POST /api/mcp/tools   (list)
 *           └─ HTTP POST /api/mcp/call    (execute)
 *                 └─ runs in main SAX process with Ari + policy + approval
 */
export const handleMcpRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/mcp/tools") {
    const tools = ctx.allAgentTools
      .filter(t => !MCP_HIDDEN_TOOLS.has(t.name))
      .map(t => ({
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
      if (MCP_HIDDEN_TOOLS.has(body.name)) {
        json(403, { error: `tool '${body.name}' is not available via MCP — use op_submit_async + auto-notify instead` });
        return true;
      }

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
        ctx.getActiveOnEvent(sessionId), // pipe tool_start / tool_end / tool_progress to that session's SSE stream
        undefined, // signal
      );

      const content = serializeMcpContent(results as Array<{ role: string; content: unknown }>);
      const plainText = content.filter(block => block.type === "text").map(block => String(block.text || "")).join("\n");

      json(200, {
        content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }],
        isError: plainText.startsWith("BLOCKED") || plainText.startsWith("Tool execution failed"),
      });
    } catch (e) {
      json(500, { error: safeErrorMessage(e) });
    }
    return true;
  }

  return false;
};
