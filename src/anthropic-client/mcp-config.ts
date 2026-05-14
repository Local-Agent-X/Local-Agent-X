/**
 * Shared MCP-config writer for `claude -p --mcp-config <path>`.
 *
 * Two callers — stream-cli.ts (cold-spawn path) and warm-pool.ts (warm path)
 * — used to maintain copy-pasted versions of this and drifted. The
 * cold-spawn copy carried PATH/USERPROFILE/etc. through to the bridge
 * subprocess; the warm-pool copy did not. Per MCP spec, `env` REPLACES the
 * parent env when the CLI spawns the bridge — without PATH the spawned
 * `node` binary isn't resolvable, the bridge dies silently before printing
 * the initialize response, and Claude CLI's init event reports
 * `mcp_servers: []`. Live failure 2026-05-14: model saw zero MCP tools and
 * either hallucinated completed work or improvised tool calls as decorated
 * text (`<tool_use>...`, `Tool use: build_app`, `//gpu_dispatch:builder`).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface McpConfigInput {
  /** Local Agent X server port (bridge calls back over HTTP). */
  port: number;
  /** Local Agent X auth token. */
  token: string;
  /** Session binding for routing tool side-effects to the right WebSocket. */
  sessionId?: string;
  /** Filename slug — pool-style ("warmpool-<sess>") or random for cold spawn. */
  tag: string;
}

/**
 * Writes the MCP config JSON to `~/.lax/tmp/mcp-<tag>.json` and returns the
 * absolute path. Caller is responsible for unlinking when done (cold path
 * deletes per-request; warm-pool deletes on process exit).
 */
export function writeMcpConfig(input: McpConfigInput): string {
  const tmpDir = join(homedir(), ".lax", "tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const configPath = join(tmpDir, `mcp-${input.tag}.json`);

  const here = import.meta.dirname || ".";
  const tsPath = resolve(join(here, "..", "mcp-bridge.ts"));
  const jsPath = resolve(join(here, "..", "mcp-bridge.js"));
  const bridgePath = existsSync(jsPath) ? jsPath : tsPath;
  const needsTsx = bridgePath.endsWith(".ts");

  const env: Record<string, string> = {
    LAX_MCP_URL: `http://127.0.0.1:${input.port}`,
    LAX_MCP_TOKEN: input.token,
    ...(input.sessionId ? { LAX_MCP_SESSION_ID: input.sessionId } : {}),
    // Host-env passthrough. MCP spec REPLACES parent env (does not merge),
    // so without these the bridge subprocess can't find `node` and dies
    // before printing the initialize response. See file header for the
    // failure mode this prevents.
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    ...(process.env.APPDATA ? { APPDATA: process.env.APPDATA } : {}),
    ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  };

  const mcpConfig = {
    mcpServers: {
      lax: {
        command: "node",
        args: needsTsx ? ["--import=tsx", bridgePath] : [bridgePath],
        env,
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
  return configPath;
}
