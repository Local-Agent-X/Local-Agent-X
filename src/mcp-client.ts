/**
 * MCP Client — connects to Model Context Protocol servers.
 *
 * Each MCP server is a subprocess (stdio transport) that exposes tools,
 * resources, and prompts via JSON-RPC 2.0. This client manages the lifecycle
 * of multiple servers and presents their tools as standard ToolDefinitions
 * that plug directly into our tool executor.
 *
 * Config lives at ~/.sax/mcp.json:
 * {
 *   "servers": {
 *     "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } },
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"] }
 *   }
 * }
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition, ToolResult } from "./types.js";

const PROTOCOL_VERSION = "2025-11-25";
const REQUEST_TIMEOUT_MS = 30_000;

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
        console.warn(`[mcp:${this.serverName}] ${trimmed.slice(0, 200)}`);
      }
    });

    this.proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.warn(`[mcp:${this.serverName}] Process exited with code ${code}`);
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
      clientInfo: { name: "open-agent-x", version: "1.0.0" },
    });
    this.notify("initialized", {});

    // Discover tools
    const result = await this.request("tools/list", {}) as { tools: MCPTool[] };
    this.tools = result.tools || [];
    console.log(`[mcp:${this.serverName}] Connected — ${this.tools.length} tools: ${this.tools.map(t => t.name).join(", ")}`);
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
      return { content: text || "(no output)", isError: result.isError || false };
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

  /** Load config and connect to all enabled servers. */
  async connectAll(): Promise<void> {
    const config = this.loadConfig();
    for (const [name, serverConfig] of Object.entries(config.servers)) {
      if (serverConfig.disabled) continue;
      if (this.connections.has(name) && this.connections.get(name)!.connected) continue;
      try {
        const conn = new MCPConnection(name, serverConfig);
        await conn.connect();
        this.connections.set(name, conn);
      } catch (e) {
        console.warn(`[mcp] Failed to connect to ${name}: ${(e as Error).message}`);
      }
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
    // Create default config with examples (all disabled)
    const defaultConfig: MCPConfig = {
      servers: {
        // Uncomment and configure to enable:
        // "github": {
        //   "command": "npx",
        //   "args": ["-y", "@modelcontextprotocol/server-github"],
        //   "env": { "GITHUB_TOKEN": "your-token-here" }
        // },
        // "filesystem": {
        //   "command": "npx",
        //   "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
        // },
        // "postgres": {
        //   "command": "npx",
        //   "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
        // },
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
