/**
 * MCP Bridge — spawned as a subprocess by Claude CLI.
 * Translates MCP JSON-RPC over stdio into HTTP calls back to the main
 * SAX server. That keeps tool execution inside the main process with full
 * Ari / policy / approval coverage.
 *
 * Expected env (set by anthropic-client.ts when writing the MCP config):
 *   SAX_MCP_URL   — base URL of the SAX server (e.g. http://127.0.0.1:7007)
 *   SAX_MCP_TOKEN — SAX auth token for the endpoints
 */

const BASE = process.env.SAX_MCP_URL;
const TOKEN = process.env.SAX_MCP_TOKEN;
const PROTOCOL_VERSION = "2025-11-25";

if (!BASE || !TOKEN) {
  process.stderr.write("[mcp-bridge] SAX_MCP_URL / SAX_MCP_TOKEN not set\n");
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
            serverInfo: { name: "sax-mcp-bridge", version: "0.1.0" },
          },
        };

      case "initialized":
      case "notifications/initialized":
        return null; // notification, no response

      case "tools/list": {
        const res = await fetch(`${BASE}/api/mcp/tools`, {
          headers: { "Authorization": `Bearer ${TOKEN}` },
        });
        if (!res.ok) throw new Error(`SAX tools/list: ${res.status}`);
        const data = await res.json() as { tools: unknown[] };
        return { jsonrpc: "2.0", id, result: { tools: data.tools } };
      }

      case "tools/call": {
        const params = req.params as { name: string; arguments?: Record<string, unknown> };
        const res = await fetch(`${BASE}/api/mcp/call`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: params.name, arguments: params.arguments || {} }),
        });
        const data = await res.json() as { content?: unknown; isError?: boolean; error?: string };
        if (!res.ok) throw new Error(data.error || `SAX tools/call: ${res.status}`);
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
