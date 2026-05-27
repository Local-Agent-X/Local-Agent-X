import { spawn, type ChildProcess } from "node:child_process";

import { createLogger } from "../logger.js";
import { wrapExternalContent } from "../sanitize.js";
import type { ToolResult } from "../types.js";
import { type MCPServerConfig, type MCPTool, type PendingRequest, PROTOCOL_VERSION, REQUEST_TIMEOUT_MS } from "./types.js";

const logger = createLogger("mcp-client");

// ─────────────────────────────────────────────────────────────────────
// MCP child env construction
//
// Default-deny. The previous spawn-env merge handed every host env var
// (ANTHROPIC_API_KEY, AWS creds, GitHub tokens, …) to every MCP
// subprocess. Replaced with a curated allowlist of vars MCP
// children legitimately need for binary resolution / locale / temp dirs,
// plus explicit per-server grants. A deny-pattern filter runs AFTER the
// merge so a caller cannot grant a credential via configEnv either —
// credentials must flow through the secret vault, never env injection.
// ─────────────────────────────────────────────────────────────────────

const ENV_ALLOWLIST: readonly string[] = [
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
  // POSIX shell discovery
  "SHELL",
  // Unix identity
  "USER", "LOGNAME",
  // Linux XDG dirs
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  // Node module resolution
  "NODE_PATH",
];

const DENY_PREFIXES: readonly string[] = [
  "ANTHROPIC_", "OPENAI_", "AWS_", "GOOGLE_", "AZURE_", "GCP_",
  "STRIPE_", "TWILIO_", "SENDGRID_", "MAILGUN_",
  "LAX_AUTH_", "SAX_AUTH_", "LAX_MCP_TOKEN",
];

const DENY_SUBSTRINGS: readonly string[] = [
  "_KEY", "_SECRET", "_TOKEN", "_PASSWORD", "_PASSWD",
  "_CREDENTIAL", "_PRIVATE", "_API_KEY",
];

const DENY_EXACT: readonly string[] = [
  "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "HF_TOKEN",
  "DATABASE_URL", "DB_PASSWORD",
];

function isCredentialKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (DENY_EXACT.includes(upper)) return true;
  for (const prefix of DENY_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  for (const sub of DENY_SUBSTRINGS) {
    if (upper.includes(sub)) return true;
  }
  return false;
}

let allowlistLogged = false;

/**
 * Build the env for an MCP child subprocess. Default-deny: only the
 * curated allowlist passes through from process.env, then per-server
 * grants from `configEnv`, then a final credential-pattern strip that
 * even overrides caller grants (credentials belong in the secret vault,
 * not env injection).
 */
export function buildMcpChildEnv(configEnv?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};

  // Allowlist passthrough
  const granted: string[] = [];
  for (const key of ENV_ALLOWLIST) {
    const val = process.env[key];
    if (typeof val === "string" && val.length > 0) {
      out[key] = val;
      granted.push(key);
    }
  }

  if (!allowlistLogged) {
    logger.info(`mcp-env: allowlist active (${granted.length} vars passed: ${granted.join(", ") || "<none>"})`);
    allowlistLogged = true;
  }

  // Per-server grants (caller-controlled, overrides allowlist values)
  if (configEnv) {
    for (const [k, v] of Object.entries(configEnv)) {
      if (typeof v === "string") out[k] = v;
    }
  }

  // Final credential strip — runs after merge so caller grants can't
  // smuggle a credential through either.
  const stripped: string[] = [];
  for (const key of Object.keys(out)) {
    if (isCredentialKey(key)) {
      delete out[key];
      stripped.push(key);
    }
  }
  if (stripped.length > 0) {
    logger.warn(`mcp-env: stripped credential-pattern keys (use secret vault instead): ${stripped.join(", ")}`);
  }

  return out;
}

// Test-only reset for the once-per-process info log. Not exported via
// the public API; consumed by env-builder tests to assert clean state
// across test cases.
export function __resetMcpEnvLogState(): void {
  allowlistLogged = false;
}

export class MCPConnection {
  private proc: ChildProcess | null = null;
  private messageId = 0;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private tools: MCPTool[] = [];
  readonly serverName: string;

  constructor(serverName: string, private config: MCPServerConfig) {
    this.serverName = serverName;
  }

  async connect(): Promise<void> {
    const env = buildMcpChildEnv(this.config.env);

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
      for (const [, handler] of this.pending) {
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
