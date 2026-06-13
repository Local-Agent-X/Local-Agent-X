import type { ToolDefinition, ToolResult } from "../types.js";
import type { MCPServerConfig } from "../mcp-client/types.js";
import { MCPManager } from "../mcp-client/index.js";

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const ok = (content: string): ToolResult => ({ content });
const fail = (content: string): ToolResult => ({ content, isError: true });

/**
 * Agent-facing MCP administration. Lets the agent set up an external MCP
 * server on request ("connect the GitHub MCP"), reusing the same MCPManager
 * the settings UI drives. Pairs with request_secret for credentials — the
 * agent never handles raw tokens; it references them as ${secret:NAME}.
 */
export function createMcpAdminTools(): ToolDefinition[] {
  const addServer: ToolDefinition = {
    name: "mcp_add_server",
    description:
      "Add and connect an external Model Context Protocol (MCP) server so its tools become available to you. " +
      "Use for requests like \"set up the GitHub MCP\" or \"connect a Postgres MCP server\". The server runs as a " +
      "local subprocess (usually via npx). Reference any credential as ${secret:NAME} in env or args — NEVER inline a " +
      "raw token. If the needed secret isn't stored yet, call request_secret first (the user pastes it securely), then " +
      "call this. Common servers: github (npx -y @modelcontextprotocol/server-github, env " +
      "GITHUB_PERSONAL_ACCESS_TOKEN=${secret:GITHUB_TOKEN}); postgres (npx -y @modelcontextprotocol/server-postgres " +
      "${secret:POSTGRES_URL}); slack (npx -y @modelcontextprotocol/server-slack, env SLACK_BOT_TOKEN=${secret:SLACK_BOT_TOKEN}); " +
      "puppeteer (npx -y @modelcontextprotocol/server-puppeteer, no secret). Idempotent: calling again with the same name " +
      "re-applies and reconnects — use that to connect a server after its secret has been saved.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short server id, e.g. \"github\". Letters, digits, _ or - only." },
        command: { type: "string", description: "Executable that launches the server, e.g. \"npx\"." },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments, e.g. [\"-y\", \"@modelcontextprotocol/server-github\"]. Use ${secret:NAME} for a credential passed as an argument.",
        },
        env: {
          type: "object",
          description: "Environment variables for the subprocess, e.g. {\"GITHUB_PERSONAL_ACCESS_TOKEN\": \"${secret:GITHUB_TOKEN}\"}. Use ${secret:NAME} references, never raw tokens.",
        },
      },
      required: ["name", "command"],
    },
    async execute(args) {
      const name = String(args.name || "").trim();
      const command = String(args.command || "").trim();
      if (!NAME_RE.test(name)) return fail("Invalid server name — use 1-64 chars: letters, digits, _ or -.");
      if (!command) return fail("command is required (e.g. \"npx\").");

      const argList = Array.isArray(args.args) ? args.args.filter(a => typeof a === "string").map(String) : [];
      const env: Record<string, string> = {};
      if (args.env && typeof args.env === "object" && !Array.isArray(args.env)) {
        for (const [k, v] of Object.entries(args.env as Record<string, unknown>)) {
          if (typeof v === "string" && k.trim()) env[k.trim()] = v;
        }
      }

      const mgr = MCPManager.getInstance();
      const config: MCPServerConfig = { command, args: argList, disabled: false };
      if (Object.keys(env).length > 0) config.env = env;
      mgr.addServer(name, config);
      await mgr.reload();

      const status = mgr.getServers().find(s => s.name === name);
      if (!status) return fail(`Added "${name}" but it vanished from the config — check the server logs.`);
      if (status.redundant) {
        return ok(`"${name}" duplicates a built-in surface (native read/write/edit) and is not started — no action needed.`);
      }
      if (status.missingSecrets.length > 0) {
        return ok(
          `Added MCP server "${name}", but it needs secret(s): ${status.missingSecrets.join(", ")}. ` +
          `Call request_secret for each (the user provides them securely), then call mcp_add_server again with the same arguments to connect.`,
        );
      }
      if (status.connected) {
        const toolList = status.tools.length ? ` Tools: ${status.tools.join(", ")}.` : "";
        return ok(`Connected MCP server "${name}" — ${status.toolCount} tool(s) now available as mcp_${name}_*.${toolList}`);
      }
      return fail(
        `Added "${name}" but it failed to connect (no tools, no missing secrets). ` +
        `The command/args may be wrong or the package failed to start — check the server logs.`,
      );
    },
  };

  return [addServer];
}
