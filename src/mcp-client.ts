/**
 * MCP Client — connects to Model Context Protocol servers.
 *
 * Each MCP server is a subprocess (stdio transport) that exposes tools,
 * resources, and prompts via JSON-RPC 2.0. This client manages the lifecycle
 * of multiple servers and presents their tools as standard ToolDefinitions
 * that plug directly into our tool executor.
 *
 * Config lives at ~/.lax/mcp.json:
 * {
 *   "servers": {
 *     "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } },
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"] }
 *   }
 * }
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition, ToolResult } from "./types.js";
import { wrapExternalContent } from "./sanitize.js";

import { createLogger } from "./logger.js";
const logger = createLogger("mcp-client");

const PROTOCOL_VERSION = "2025-11-25";
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Secret lookup is INJECTABLE so unit tests can drive it without booting
 * the real vault. Default delegates to the secrets-store singleton if it
 * exists; tests overwrite via `setSecretLookup` to drive deterministic
 * scenarios.
 *
 * Lazy delegation also handles bootstrap order — the MCP manager is
 * instantiated before the vault is guaranteed to exist (test envs, fresh
 * installs, CLI bootstrap). A missing vault yields `undefined` instead of
 * crashing the manager.
 */
type SecretLookup = (name: string) => string | undefined;

let secretLookup: SecretLookup = (name: string) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./secrets.js") as { getSecretsStoreSingleton?: () => { get(n: string): string | undefined } | null };
    const store = mod.getSecretsStoreSingleton?.();
    return store?.get(name);
  } catch {
    return undefined;
  }
};

/** Test seam: override the secret-resolution function. Pass `null` to reset. */
export function setSecretLookup(fn: SecretLookup | null): void {
  secretLookup = fn ?? ((name: string) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./secrets.js") as { getSecretsStoreSingleton?: () => { get(n: string): string | undefined } | null };
      const store = mod.getSecretsStoreSingleton?.();
      return store?.get(name);
    } catch {
      return undefined;
    }
  });
}

function lookupSecret(name: string): string | undefined {
  return secretLookup(name);
}

/**
 * Expand `${...}` placeholders in a config string. Supported forms:
 *   - `${HOME}` / `${USERPROFILE}` — OS home directory (portable across machines)
 *   - `${secret:NAME}` — read from the encrypted secrets vault
 *   - `~/` prefix — also expands to home directory
 *
 * Deliberately does NOT expand bare `$VAR` or `$(cmd)` — only the explicit
 * `${...}` form. This blocks shell-style injection from a config file an
 * attacker might tamper with: `command: "$(rm -rf /)"` would be passed
 * through verbatim, never evaluated.
 *
 * Returns the expanded string AND a list of placeholders that couldn't be
 * resolved (e.g. `${secret:MISSING}` when the vault has no MISSING). Callers
 * use the `missing` list to decide whether to skip starting a server with
 * unresolved required env.
 */
export function expandPlaceholders(input: string): { value: string; missing: string[] } {
  if (typeof input !== "string") return { value: input, missing: [] };
  const missing: string[] = [];
  let out = input;

  // 1. `~/` prefix → home dir (POSIX convention, also works on Windows).
  if (out.startsWith("~/") || out.startsWith("~\\")) {
    out = homedir() + out.slice(1);
  }

  // 2. ${HOME} / ${USERPROFILE} — OS home dir
  out = out.replace(/\$\{HOME\}/g, () => homedir());
  out = out.replace(/\$\{USERPROFILE\}/g, () => process.env.USERPROFILE || homedir());

  // 3. ${secret:NAME} — vault lookup. Anything still missing after lookup
  //    is reported back to the caller via `missing`; we leave the original
  //    placeholder in the string so logs surface the unresolved name
  //    instead of an empty value silently injected.
  out = out.replace(/\$\{secret:([A-Z0-9_]+)\}/g, (match, name: string) => {
    const v = lookupSecret(name);
    if (v) return v;
    missing.push(name);
    return match;
  });

  return { value: out, missing };
}

function expandPlaceholdersDeep(
  config: MCPServerConfig,
): { config: MCPServerConfig; missing: string[] } {
  const allMissing: string[] = [];
  const args = (config.args || []).map(a => {
    const r = expandPlaceholders(a);
    allMissing.push(...r.missing);
    return r.value;
  });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.env || {})) {
    const r = expandPlaceholders(v);
    allMissing.push(...r.missing);
    env[k] = r.value;
  }
  const cmd = expandPlaceholders(config.command);
  allMissing.push(...cmd.missing);
  return {
    config: { ...config, command: cmd.value, args, env },
    missing: Array.from(new Set(allMissing)),
  };
}

interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

interface MCPConfig {
  servers: Record<string, MCPServerConfig>;
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class MCPConnection {
  private proc: ChildProcess | null = null;
  private messageId = 0;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private tools: MCPTool[] = [];
  readonly serverName: string;

  constructor(
    serverName: string,
    private config: MCPServerConfig
  ) {
    this.serverName = serverName;
  }

  async connect(): Promise<void> {
    const env = { ...process.env, ...(this.config.env || {}) };

    this.proc = spawn(this.config.command, this.config.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    this.proc.stdout?.setEncoding("utf-8");
    this.proc.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) {
            const handler = this.pending.get(msg.id);
            if (handler) {
              clearTimeout(handler.timer);
              this.pending.delete(msg.id);
              if (msg.error) handler.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              else handler.resolve(msg.result);
            }
          }
        } catch {}
      }
    });

    this.proc.stderr?.setEncoding("utf-8");
    this.proc.stderr?.on("data", (chunk: string) => {
      // MCP servers log to stderr — only show errors, not info
      const trimmed = chunk.trim();
      if (trimmed && /error|fail|crash/i.test(trimmed)) {
        logger.warn(`[mcp:${this.serverName}] ${trimmed.slice(0, 200)}`);
      }
    });

    this.proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        logger.warn(`[mcp:${this.serverName}] Process exited with code ${code}`);
      }
      // Reject all pending requests
      for (const [id, handler] of this.pending) {
        clearTimeout(handler.timer);
        handler.reject(new Error(`MCP server ${this.serverName} exited`));
      }
      this.pending.clear();
      this.proc = null;
    });

    // Handshake
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: "local-agent-x", version: "1.0.0" },
    });
    this.notify("initialized", {});

    // Discover tools
    const result = await this.request("tools/list", {}) as { tools: MCPTool[] };
    this.tools = result.tools || [];
    logger.info(`[mcp:${this.serverName}] Connected — ${this.tools.length} tools: ${this.tools.map(t => t.name).join(", ")}`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error(`MCP server ${this.serverName} not connected`));
        return;
      }
      const id = ++this.messageId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin.write(msg);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc.stdin.write(msg);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.request("tools/call", { name, arguments: args }) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (result.content || [])
        .filter(c => c.type === "text" && c.text)
        .map(c => c.text)
        .join("\n");
      const raw = text || "(no output)";
      // Wrap MCP server output as external untrusted content. The server is a
      // third-party process — its responses can carry prompt-injection
      // payloads, malformed data, or content we have no provenance on. The
      // wrap surfaces an explicit warning to the model AND runs the secret
      // redactor over the body so any vault value that leaked through gets
      // scrubbed before reaching the agent's prompt.
      const wrapped = wrapExternalContent(raw, `mcp:${this.serverName}`, {
        tool: name,
      });
      return { content: wrapped, isError: result.isError || false };
    } catch (e) {
      return { content: `MCP tool error: ${(e as Error).message}`, isError: true };
    }
  }

  getTools(): MCPTool[] {
    return this.tools;
  }

  disconnect(): void {
    for (const [, handler] of this.pending) {
      clearTimeout(handler.timer);
      handler.reject(new Error("Disconnecting"));
    }
    this.pending.clear();
    this.proc?.kill();
    this.proc = null;
  }

  get connected(): boolean {
    return this.proc !== null && !this.proc.killed;
  }
}

// ── MCP Manager (singleton) ──

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
