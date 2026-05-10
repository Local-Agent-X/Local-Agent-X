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
import { homedir } from "node:os";

import { createLogger } from "./logger.js";
import { MCPConnection } from "./mcp-client/connection.js";
import { expandPlaceholdersDeep } from "./mcp-client/placeholders.js";
import type { MCPConfig, MCPServerConfig } from "./mcp-client/types.js";
import type { ToolDefinition, ToolResult } from "./types.js";

const logger = createLogger("mcp-client");

export { expandPlaceholders, setSecretLookup } from "./mcp-client/placeholders.js";

export class MCPManager {
  private static instance: MCPManager | null = null;
  private connections = new Map<string, MCPConnection>();
  private configPath: string;

  private constructor(dataDir: string) {
    this.configPath = join(dataDir, "mcp.json");
  }

  static getInstance(dataDir?: string): MCPManager {
    if (!MCPManager.instance) {
      MCPManager.instance = new MCPManager(dataDir || join(homedir(), ".lax"));
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
        const conn = new MCPConnection(name, expanded.config);
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
    const defaultConfig: MCPConfig = {
      servers: {
        "filesystem": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "${HOME}/Documents"],
          disabled: true,
        },
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
      mkdirSync(join(homedir(), ".lax"), { recursive: true });
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
