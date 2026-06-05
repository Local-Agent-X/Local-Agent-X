/**
 * MCP Bridge — spawned as a subprocess by Claude CLI.
 * Translates MCP JSON-RPC over stdio into HTTP calls back to the main
 * Local Agent X server. That keeps tool execution inside the main process with full
 * Ari / policy / approval coverage.
 *
 * Expected env (set by anthropic-client.ts when writing the MCP config):
 *   LAX_MCP_URL   — base URL of the Local Agent X server (e.g. http://127.0.0.1:7007)
 *   LAX_MCP_TOKEN — Local Agent X auth token for the endpoints
 *   (legacy LAX_MCP_URL / LAX_MCP_TOKEN still read as fallback)
 */

const BASE = process.env.LAX_MCP_URL;
const TOKEN = process.env.LAX_MCP_TOKEN;
// Use the latest released MCP spec version. Claude CLI 2.1.116 rejects
// servers that announce an unknown protocolVersion with a silent `status:
// "failed"` in the init event. Stick to spec releases (2024-11-05,
// 2025-03-26, 2025-06-18); newer "future-dated" strings get dropped.
const PROTOCOL_VERSION = "2025-06-18";

if (!BASE || !TOKEN) {
  process.stderr.write("[mcp-bridge] LAX_MCP_URL / LAX_MCP_TOKEN not set\n");
  process.exit(1);
}

interface JsonRpcRequest { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown }
interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: { code: number; message: string } }

function send(msg: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? 0;
  try {
    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "lax-mcp-bridge", version: "0.1.0" },
          },
        };

      case "initialized":
      case "notifications/initialized":
        return null; // notification, no response

      case "tools/list": {
        // Cold-start race fix: when the worker spawns and Claude CLI
        // immediately handshakes with the bridge, the bridge subprocess
        // sometimes initiates its first fetch before the localhost
        // connection is fully ready (or before any other transient
        // condition resolves), which made Claude believe LAX exposed zero
        // tools. Result: agent told user "I don't have file system tools"
        // and bailed without doing anything.
        //
        // Retry the tools/list fetch with backoff. We'll try up to 5 times,
        // backing off 200ms → 400ms → 800ms → 1.6s → 3.2s. Total worst case
        // ~6s before giving up; in practice the second attempt almost
        // always succeeds. Empty tools array also triggers retry — a
        // legitimate cold-LAX would never return an empty tools list, so
        // we treat it as a transient failure.
        let lastErr = "";
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const res = await fetch(`${BASE}/api/mcp/tools`, {
              headers: { "Authorization": `Bearer ${TOKEN}` },
            });
            if (!res.ok) {
              lastErr = `HTTP ${res.status}`;
            } else {
              const data = await res.json() as { tools: unknown[] };
              if (Array.isArray(data.tools) && data.tools.length > 0) {
                return { jsonrpc: "2.0", id, result: { tools: data.tools } };
              }
              lastErr = "empty tools list";
            }
          } catch (e) {
            lastErr = (e as Error).message;
          }
          if (attempt < 4) {
            const delay = 200 * Math.pow(2, attempt);
            process.stderr.write(`[mcp-bridge] tools/list attempt ${attempt + 1} failed (${lastErr}), retrying in ${delay}ms\n`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
        throw new Error(`Local Agent X tools/list failed after 5 attempts: ${lastErr}`);
      }

      case "tools/call": {
        const params = req.params as { name: string; arguments?: Record<string, unknown> };
        const sessionId = process.env.LAX_MCP_SESSION_ID;
        const body: Record<string, unknown> = { name: params.name, arguments: params.arguments || {} };
        if (sessionId) body.sessionId = sessionId;
        const res = await fetch(`${BASE}/api/mcp/call`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json() as { content?: unknown; isError?: boolean; error?: string };
        if (!res.ok) throw new Error(data.error || `Local Agent X tools/call: ${res.status}`);
        return {
          jsonrpc: "2.0", id,
          result: { content: data.content || [{ type: "text", text: "(no output)" }], isError: !!data.isError },
        };
      }

      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32000, message: (e as Error).message } };
  }
}

let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk: string) => {
  buf += chunk;
  let newlineIdx: number;
  while ((newlineIdx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, newlineIdx).trim();
    buf = buf.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      const resp = await handleRequest(req);
      if (resp) send(resp);
    } catch (e) {
      process.stderr.write(`[mcp-bridge] parse error: ${(e as Error).message}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
