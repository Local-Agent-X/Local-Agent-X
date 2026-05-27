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
import { join, resolve } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";
import { isCredentialKey } from "../mcp-client/connection.js";

const logger = createLogger("mcp-config");

// Host-env keys the bridge subprocess is allowed to inherit. MCP spec
// REPLACES parent env (does not merge) when Claude CLI spawns the bridge
// — without PATH the spawned `node` isn't resolvable and the bridge dies
// silently before announcing tools (live failure 2026-05-14; see file
// header). Mirrors the external-MCP allowlist for parity, minus
// `NODE_PATH`/`SHELL`/`USER`/`LOGNAME` which the bridge has no use for.
const HOST_ENV_ALLOWLIST: readonly string[] = [
  // Binary resolution
  "PATH", "PATHEXT",
  // Home dir
  "HOME", "USERPROFILE",
  // Windows shell + system paths
  "SYSTEMROOT", "WINDIR", "COMSPEC",
  // Windows user dirs
  "APPDATA", "LOCALAPPDATA",
  // Temp dirs
  "TMPDIR", "TEMP", "TMP",
  // Locale
  "LANG", "LC_ALL", "LC_CTYPE",
  // Linux XDG dirs
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
];

// `LAX_MCP_TOKEN` matches the shared deny-prefix table (it lives there so
// external untrusted MCP servers don't receive our auth token). The
// bridge subprocess IS trusted code and needs the token to call back to
// LAX, so the strip pass below exempts it for this path only.
const BRIDGE_EXEMPT_CREDENTIAL_KEYS: ReadonlySet<string> = new Set(["LAX_MCP_TOKEN"]);

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
  const tmpDir = join(getLaxDir(), "tmp");
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
  };
  // Host-env passthrough (curated allowlist). MCP spec REPLACES parent
  // env when the CLI spawns the bridge, so vars not in this set are gone.
  for (const key of HOST_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (typeof val === "string" && val.length > 0) env[key] = val;
  }
  // Defense-in-depth credential strip. The allowlist above already
  // excludes credential-shaped keys, but this catches future drift — if a
  // contributor adds `OPENAI_API_KEY` to the allowlist or a caller starts
  // injecting via input, the strip refuses it and logs the key name only.
  // LAX_MCP_TOKEN is exempt because the bridge needs it to authenticate.
  const stripped: string[] = [];
  for (const key of Object.keys(env)) {
    if (isCredentialKey(key, BRIDGE_EXEMPT_CREDENTIAL_KEYS)) {
      delete env[key];
      stripped.push(key);
    }
  }
  if (stripped.length > 0) {
    logger.warn(`bridge-env: stripped credential-pattern keys (use secret vault instead): ${stripped.join(", ")}`);
  }

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
