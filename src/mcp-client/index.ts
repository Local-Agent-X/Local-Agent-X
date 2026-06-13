/**
 * MCP Client — connects to Model Context Protocol servers.
 *
 * Each MCP server is a subprocess (stdio transport) that exposes tools,
 * resources, and prompts via JSON-RPC 2.0. This file holds the manager
 * (singleton + config + lifecycle); the connection-per-server logic and
 * placeholder/secret expansion live in src/mcp-client/.
 *
 * Config lives at ~/.lax/mcp.json:
 * {
 *   "servers": {
 *     "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } },
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"] }
 *   }
 * }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

import { createLogger } from "../logger.js";
import { MCPConnection } from "./connection.js";
import { expandPlaceholdersDeep } from "./placeholders.js";
import type { MCPConfig, MCPServerConfig } from "./types.js";
import type { ToolDefinition, ToolResult } from "../types.js";

const logger = createLogger("mcp-client");

// Servers whose tools we'd unconditionally drop after connecting. Mirror of
// the post-connect filter in src/server/bootstrap-tools.ts — keep them in
// sync. Skipping at connect time saves the subprocess spawn cost (12s on
// boot for the filesystem server) rather than paying it and throwing away
// the result.
const REDUNDANT_MCP_SERVERS = new Set<string>(["filesystem"]);

export interface MCPServerStatus {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  disabled: boolean;
  redundant: boolean;
  connected: boolean;
  toolCount: number;
  tools: string[];
  missingSecrets: string[];
}

/**
 * Mask env values for display. Placeholder references (`${secret:X}`,
 * `${HOME}`) are safe to surface as-is — they're pointers, not secrets. A
 * literal inlined value gets masked so a raw token someone pasted into
 * mcp.json against advice never reaches the settings DOM.
 */
function maskEnv(env?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env || {})) {
    out[k] = /\$\{[^}]+\}/.test(v) ? v : "••••••••";
  }
  return out;
}

export { expandPlaceholders, setSecretLookup } from "./placeholders.js";

export class MCPManager {
  private static instance: MCPManager | null = null;
  private connections = new Map<string, MCPConnection>();
  private configPath: string;

  private constructor(dataDir: string) {
    this.configPath = join(dataDir, "mcp.json");
  }

  static getInstance(dataDir?: string): MCPManager {
    if (!MCPManager.instance) {
      MCPManager.instance = new MCPManager(dataDir || getLaxDir());
    }
    return MCPManager.instance;
  }

  /**
   * Load config and connect to all enabled servers.
   *
   * Servers whose config references a `${secret:NAME}` placeholder that
   * doesn't resolve are SKIPPED (with INFO log) — not warnings. Missing
   * tokens are an expected state on a fresh install or before the user
   * configures the relevant integration; spamming WARN noise on every boot
   * trains operators to ignore real warnings.
   */
  async connectAll(): Promise<void> {
    const config = this.loadConfig();
    for (const [name, raw] of Object.entries(config.servers)) {
      if (raw.disabled) continue;
      // Skip servers whose tools we'd unconditionally filter as redundant.
      // The MCP filesystem server emits read/write/edit/list tools that
      // duplicate native `read`/`write`/`edit`/`bash` with worse safety
      // posture (no SecurityLayer integration, default-deny in
      // tool-policy). Connecting just to drop all 14 tools costs ~12s of
      // subprocess spawn on every boot. Skip the connection entirely.
      if (REDUNDANT_MCP_SERVERS.has(name)) {
        logger.info(`[mcp] Skipping "${name}" — tools duplicate native equivalents (see bootstrap-tools.ts filter)`);
        continue;
      }
      if (this.connections.has(name) && this.connections.get(name)!.connected) continue;

      // Expand ${HOME}/${secret:...}/etc. before spawning. If a server
      // requires a secret that isn't in the vault, skip it cleanly.
      const expanded = expandPlaceholdersDeep(raw);
      if (expanded.missing.length > 0) {
        logger.info(
          `[mcp] Skipping "${name}" — missing secret(s): ${expanded.missing.join(", ")}. ` +
          `Add via secret_save or the secrets UI to enable.`,
        );
        continue;
      }

      try {
        const conn = new MCPConnection(name, expanded.config, expanded.secretEnvKeys);
        await conn.connect();
        this.connections.set(name, conn);
      } catch (e) {
        logger.warn(`[mcp] Failed to connect to ${name}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Disconnect everything, then reconnect from the (re-read) config file.
   * Used by the file watcher when ~/.lax/mcp.json changes — no server
   * restart required to pick up new servers, removed servers, or token
   * additions in the vault. Safe to call repeatedly.
   */
  async reload(): Promise<void> {
    this.disconnectAll();
    await this.connectAll();
    this.onToolsChanged?.();
  }

  private fileWatcher: FSWatcher | null = null;

  /**
   * Start watching the config file. On change, debounce briefly (the editor
   * fires multiple events on a single save) then call reload().
   */
  startConfigWatcher(): void {
    if (this.fileWatcher) return;
    if (!existsSync(this.configPath)) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    try {
      this.fileWatcher = fsWatch(this.configPath, () => {
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          pending = null;
          logger.info("[mcp] config changed — reloading");
          this.reload().catch(e => logger.warn(`[mcp] reload failed: ${(e as Error).message}`));
        }, 250);
      });
    } catch (e) {
      logger.warn(`[mcp] config watcher init failed: ${(e as Error).message}`);
    }
  }

  stopConfigWatcher(): void {
    if (this.fileWatcher) {
      try { this.fileWatcher.close(); } catch {}
      this.fileWatcher = null;
    }
  }

  /** Get all tools from all connected servers as standard ToolDefinitions. */
  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const [serverName, conn] of this.connections) {
      if (!conn.connected) continue;
      for (const mcpTool of conn.getTools()) {
        const toolName = `mcp_${serverName}_${mcpTool.name}`;
        tools.push({
          name: toolName,
          description: `[MCP:${serverName}] ${mcpTool.description || mcpTool.name}`,
          parameters: (mcpTool.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
          async execute(args: Record<string, unknown>): Promise<ToolResult> {
            return conn.callTool(mcpTool.name, args);
          },
        });
      }
    }
    return tools;
  }

  /** Get list of connected server names. */
  listServers(): Array<{ name: string; connected: boolean; toolCount: number }> {
    const result: Array<{ name: string; connected: boolean; toolCount: number }> = [];
    for (const [name, conn] of this.connections) {
      result.push({ name, connected: conn.connected, toolCount: conn.getTools().length });
    }
    return result;
  }

  /**
   * Full view for the settings UI: every server in the config file (not just
   * the connected ones `listServers` returns) merged with live connection
   * state and unresolved-secret info. `env` values that are literal inlined
   * strings are masked — only `${...}` placeholder references pass through —
   * so a token someone inlined against advice never lands in the DOM.
   */
  getServers(): MCPServerStatus[] {
    const config = this.loadConfig();
    const out: MCPServerStatus[] = [];
    for (const [name, raw] of Object.entries(config.servers)) {
      const conn = this.connections.get(name);
      const { missing } = expandPlaceholdersDeep(raw);
      out.push({
        name,
        command: raw.command,
        args: raw.args ?? [],
        env: maskEnv(raw.env),
        disabled: !!raw.disabled,
        redundant: REDUNDANT_MCP_SERVERS.has(name),
        connected: conn?.connected ?? false,
        toolCount: conn?.getTools().length ?? 0,
        tools: conn?.getTools().map(t => t.name) ?? [],
        missingSecrets: missing,
      });
    }
    return out;
  }

  /** Flip a server's `disabled` flag in the config file. Caller reloads to apply. */
  setServerDisabled(name: string, disabled: boolean): boolean {
    const config = this.loadConfig();
    const server = config.servers[name];
    if (!server) return false;
    server.disabled = disabled;
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
    return true;
  }

  /**
   * One-off connection probe for the UI's "Test" button. Spawns the server in
   * a throwaway connection, reports the tool count, and tears it down — works
   * even on a disabled server, so the user can verify config before enabling.
   */
  async testServer(name: string): Promise<{ ok: boolean; toolCount?: number; tools?: string[]; error?: string; missingSecrets?: string[] }> {
    const config = this.loadConfig();
    const raw = config.servers[name];
    if (!raw) return { ok: false, error: `Server "${name}" not found` };
    if (REDUNDANT_MCP_SERVERS.has(name)) return { ok: false, error: `"${name}" is skipped — its tools duplicate native read/write/edit` };
    const expanded = expandPlaceholdersDeep(raw);
    if (expanded.missing.length > 0) return { ok: false, missingSecrets: expanded.missing, error: `Missing secret(s): ${expanded.missing.join(", ")}` };
    const probe = new MCPConnection(name, expanded.config, expanded.secretEnvKeys);
    try {
      await probe.connect();
      const tools = probe.getTools().map(t => t.name);
      return { ok: true, toolCount: tools.length, tools };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      probe.disconnect();
    }
  }

  /**
   * Register a callback fired after every `reload()`. bootstrap-tools uses it
   * to re-sync the live `allAgentTools` array + registry from the reconnected
   * servers, so adding/removing/toggling a server (via the UI or the config
   * watcher) updates the agent's tool surface without a restart.
   */
  setOnToolsChanged(cb: () => void): void {
    this.onToolsChanged = cb;
  }
  private onToolsChanged: (() => void) | null = null;

  /** Disconnect all servers. */
  disconnectAll(): void {
    for (const conn of this.connections.values()) {
      conn.disconnect();
    }
    this.connections.clear();
  }

  /** Disconnect a specific server. */
  disconnect(serverName: string): void {
    const conn = this.connections.get(serverName);
    if (conn) {
      conn.disconnect();
      this.connections.delete(serverName);
    }
  }

  /** Load or create the MCP config file. */
  private loadConfig(): MCPConfig {
    if (existsSync(this.configPath)) {
      try {
        return JSON.parse(readFileSync(this.configPath, "utf-8"));
      } catch {
        return { servers: {} };
      }
    }
    // Default template. Servers ship `disabled: true` — flip the flag and
    // make sure the referenced secret exists in the vault to enable.
    // Placeholders `${HOME}` and `${secret:NAME}` resolve at load time so
    // a single config syncs across machines without per-machine forks.
    //
    // No `filesystem` entry: it's in REDUNDANT_MCP_SERVERS (never spawned —
    // native read/write/edit cover it), so seeding it would only show a
    // permanently-inert server in the settings UI. The skip guard still
    // catches it if a user adds one manually.
    const defaultConfig: MCPConfig = {
      servers: {
        "github": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:GITHUB_TOKEN}" },
          disabled: true,
        },
        "postgres": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-postgres", "${secret:POSTGRES_URL}"],
          disabled: true,
        },
      },
    };
    try {
      mkdirSync(getLaxDir(), { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
    } catch {}
    return defaultConfig;
  }

  /** Save a new server config entry. */
  addServer(name: string, config: MCPServerConfig): void {
    const current = this.loadConfig();
    current.servers[name] = config;
    writeFileSync(this.configPath, JSON.stringify(current, null, 2), "utf-8");
  }

  /** Remove a server config entry. */
  removeServer(name: string): void {
    const current = this.loadConfig();
    delete current.servers[name];
    writeFileSync(this.configPath, JSON.stringify(current, null, 2), "utf-8");
    this.disconnect(name);
  }
}
