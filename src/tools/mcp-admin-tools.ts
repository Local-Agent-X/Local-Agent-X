import type { ToolDefinition, ToolResult } from "../types.js";
import type { MCPServerConfig } from "../mcp-client/types.js";
import type { ToolCallContext } from "../tool-execution/context.js";
import { MCPManager, expandPlaceholders } from "../mcp-client/index.js";

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const ok = (content: string): ToolResult => ({ content });
const fail = (content: string): ToolResult => ({ content, isError: true });

/** The server an mcp_add_server call adds, exactly as it is stored, or why the call is refused. */
function requestedServer(args: Record<string, unknown>): { name: string; config: MCPServerConfig } | { error: string } {
  const name = String(args.name || "").trim();
  const command = String(args.command || "").trim();
  if (!NAME_RE.test(name)) return { error: "Invalid server name — use 1-64 chars: letters, digits, _ or -." };
  if (!command) return { error: "command is required (e.g. \"npx\")." };
  const executionMode = args.executionMode === "trusted" ? "trusted" : args.executionMode === "sandboxed" ? "sandboxed" : null;
  if (!executionMode) return { error: "executionMode must be sandboxed or trusted." };
  if (executionMode === "trusted") return { error: "Trusted MCP execution cannot be granted by an agent or synced config. Ask the user to add and approve this server in Settings → MCP Servers." };

  const argList = Array.isArray(args.args) ? args.args.filter(a => typeof a === "string").map(String) : [];
  const env: Record<string, string> = {};
  if (args.env && typeof args.env === "object" && !Array.isArray(args.env)) {
    for (const [k, v] of Object.entries(args.env as Record<string, unknown>)) {
      if (typeof v === "string" && k.trim()) env[k.trim()] = v;
    }
  }
  const config: MCPServerConfig = { command, args: argList, disabled: false, executionMode };
  if (Object.keys(env).length > 0) config.env = env;
  return { name, config };
}

/**
 * The vault secrets `config` hands to the program it starts: every name the
 * spawn-time expansion substitutes (mcp-client/placeholders.ts), whether the
 * vault holds it yet or not. Asking the expansion itself keeps this list from
 * drifting from what the child actually receives.
 */
function secretsHandedOver(config: MCPServerConfig): string[] {
  const names = new Set<string>();
  for (const value of [config.command, ...(config.args ?? []), ...Object.values(config.env ?? {})]) {
    const { resolved, missing } = expandPlaceholders(value);
    for (const n of [...resolved, ...missing]) names.add(n);
  }
  return [...names].sort();
}

/**
 * A vault secret referenced in an mcp_add_server call goes to a program the
 * agent chose, and nothing checks where that program sends it: a model
 * steered by a web page could hand any stored token to a package that posts
 * it out. So the call is put to the user under every profile, naming each
 * secret and the command, and refused when nobody can be asked
 * (require-approval.ts). A server that references no secret is gated by its
 * risk tier alone.
 */
export function mcpSecretUseGate(ctx: Pick<ToolCallContext, "tc" | "args" | "policyApprovalReason">): void {
  if (ctx.tc.name !== "mcp_add_server") return;
  const server = requestedServer(ctx.args);
  if ("error" in server) return;
  const secrets = secretsHandedOver(server.config);
  if (secrets.length === 0) return;
  const one = secrets.length === 1;
  const commandLine = [server.config.command, ...(server.config.args ?? [])].join(" ");
  const reason = `This mcp_add_server call gives the vault ${one ? "secret" : "secrets"} ${secrets.join(", ")} to MCP server "${server.name}", `
    + `a program the agent chose: \`${commandLine}\`. Nothing checks where that program sends ${one ? "it" : "them"}. `
    + `Approve it only if you asked to connect this server with ${one ? "that secret" : "those secrets"}.`;
  if (!ctx.policyApprovalReason) ctx.policyApprovalReason = reason;
  else if (!ctx.policyApprovalReason.includes(reason)) ctx.policyApprovalReason += `; ${reason}`;
}

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
      "raw token; the user is asked to approve each server that gets a secret. If the needed secret isn't stored yet, " +
      "call request_secret first (the user pastes it securely), then " +
      "call this. Common servers: github (npx -y @modelcontextprotocol/server-github, env " +
      "GITHUB_PERSONAL_ACCESS_TOKEN=${secret:GITHUB_TOKEN}); postgres (npx -y @modelcontextprotocol/server-postgres " +
      "${secret:POSTGRES_URL}); slack (npx -y @modelcontextprotocol/server-slack, env SLACK_BOT_TOKEN=${secret:SLACK_BOT_TOKEN}); " +
      "puppeteer (npx -y @modelcontextprotocol/server-puppeteer, no secret). Use executionMode=sandboxed. " +
      "Trusted host execution can only be added and approved by the user in authenticated Settings. Idempotent: calling again with the same name " +
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
        executionMode: {
          type: "string",
          enum: ["sandboxed", "trusted"],
          description: "Must be sandboxed. Trusted host execution requires a separate user-confirmed Settings action.",
        },
      },
      required: ["name", "command", "executionMode"],
    },
    async execute(args) {
      const server = requestedServer(args);
      if ("error" in server) return fail(server.error);
      const { name, config } = server;

      const mgr = MCPManager.getInstance();
      if (!mgr.getExecutionCapability().sandboxSupported) {
        return fail("This host cannot sandbox MCP child processes. Ask the user to review the server and explicitly approve trusted execution before adding it.");
      }
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
