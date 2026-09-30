import { spawn, type ChildProcess } from "node:child_process";

import { createLogger } from "../logger.js";
import { getLaxDir } from "../lax-data-dir.js";
import { wrapExternalContent } from "../sanitize.js";
import { isSeatbeltAvailable, seatbeltProfileLoads, wrapForSeatbelt } from "../sandbox/seatbelt.js";
import { isBwrapAvailable, bwrapGuardedRuns, wrapForBwrap } from "../sandbox/bwrap.js";
import { currentShellEgressBridge } from "../net/shell-egress-proxy.js";
import { shellProxyEnv } from "../tools/shell-proxy-env.js";
import { killProcessGroup, killProcessTree } from "../process-tree-kill.js";
import type { ToolResult } from "../types.js";
import { type MCPExecutionMode, type MCPServerConfig, type MCPTool, type PendingRequest, PROTOCOL_VERSION, REQUEST_TIMEOUT_MS } from "./types.js";
import { verifyOrTrust } from "./integrity.js";
import { assessMcpManifest, mcpRuntimeSourceFingerprint } from "./manifest.js";
import { buildMcpChildEnv } from "./child-env.js";
import { buildWindowsMcpSpawn } from "./windows-spawn.js";

export { buildWindowsMcpSpawn, cmdQuote } from "./windows-spawn.js";

const logger = createLogger("mcp-client");

export type MCPSandboxBackend = "seatbelt" | "bwrap";

let sandboxBackend: MCPSandboxBackend | null | undefined;

export function getMcpSandboxBackend(): MCPSandboxBackend | null {
  if (sandboxBackend !== undefined) return sandboxBackend;
  if (process.platform === "darwin" && isSeatbeltAvailable() && seatbeltProfileLoads(undefined, "guarded")) {
    sandboxBackend = "seatbelt";
  } else if (process.platform === "linux" && isBwrapAvailable() && bwrapGuardedRuns()) {
    sandboxBackend = "bwrap";
  } else {
    sandboxBackend = null;
  }
  return sandboxBackend;
}

export interface MCPExecutionPosture {
  requested: MCPExecutionMode;
  effective: "sandboxed" | "trusted" | "blocked";
  sandboxBackend: MCPSandboxBackend | null;
  trustedOnly: boolean;
}

export function getMcpExecutionPosture(
  config: Pick<MCPServerConfig, "executionMode">,
  locallyTrusted = false,
  publisherTrusted = false,
): MCPExecutionPosture {
  const requested = config.executionMode ?? "sandboxed";
  const backend = getMcpSandboxBackend();
  if (requested === "trusted") {
    return { requested, effective: locallyTrusted || publisherTrusted ? "trusted" : "blocked", sandboxBackend: backend, trustedOnly: backend === null };
  }
  return {
    requested,
    effective: backend ? "sandboxed" : "blocked",
    sandboxBackend: backend,
    trustedOnly: backend === null,
  };
}

export function __setMcpSandboxBackendForTests(value: MCPSandboxBackend | null | undefined): void {
  sandboxBackend = value;
}

export class MCPConnection {
  private proc: ChildProcess | null = null;
  private cleanupProc: ChildProcess | null = null;
  private cleanupPid: number | null = null;
  private initializationComplete = false;
  private messageId = 0;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private tools: MCPTool[] = [];
  readonly serverName: string;
  // Uppercase env-key names whose value came from a vault ${secret:...} — exempt
  // from the credential strip in buildMcpChildEnv (the legitimate injection path).
  private readonly exemptEnvKeys: ReadonlySet<string>;

  constructor(serverName: string, private config: MCPServerConfig, secretEnvKeys: readonly string[] = [],
    private locallyTrusted = false, private trustConfig: MCPServerConfig = config, private dataDir: string = getLaxDir()) {
    this.serverName = serverName;
    this.exemptEnvKeys = new Set(secretEnvKeys.map(k => k.toUpperCase()));
  }

  async connect(): Promise<void> {
    const manifest = assessMcpManifest(this.dataDir, this.serverName, this.trustConfig, { recordAcceptance: true });
    if (manifest.trust === "invalid") {
      throw new Error(`MCP server "${this.serverName}" signed manifest verification failed: ${manifest.reason}.`);
    }
    const publisherTrusted = manifest.trust === "verified";
    const posture = getMcpExecutionPosture(this.config, this.locallyTrusted, publisherTrusted);
    if (posture.effective === "blocked") {
      throw new Error(
        `MCP server "${this.serverName}" was not started: requested execution is not authorized. ` +
        `Use guarded mode where supported, or approve this exact configuration from authenticated Settings for trusted execution.`,
      );
    }

    // Signed identities replace TOFU; fallback entries retain the local pin.
    const verdict = publisherTrusted
      ? { ok: true as const, firstTrust: false, sha256: manifest.sha256!, resolvedPath: manifest.resolvedPath! }
      : verifyOrTrust(this.serverName, this.config.command);
    if (!verdict.ok) {
      throw new Error(`MCP server "${this.serverName}" integrity check failed: ${verdict.reason}. ${verdict.userHint}`);
    }
    if (verdict.firstTrust) {
      logger.info(`MCP server "${this.serverName}" trusted on first connect (sha256: ${verdict.sha256.slice(0, 12)}...).`);
    }

    // Spawn the resolved absolute path the integrity check hashed, NOT the
    // bare command name. If we re-pass `this.config.command`, Node (and on
    // Windows the cmd.exe shim) does its own PATH lookup, which can resolve
    // to a different binary than the one we just trusted (TOCTOU: PATH races,
    // evil-twin binaries appearing between hash and spawn). The trust store
    // advertises "this binary matches the hash you trusted" — that property
    // only holds if we execute the exact resolved path.
    //
    // Resolve the wrapper from the host environment before building the child
    // env. In particular, config.env.PATH must never select bwrap/cmd.exe.
    const isWin = process.platform === "win32";
    let command = verdict.resolvedPath;
    let spawnArgs = this.config.args || [];
    let windowsVerbatimArguments = false;
    // A sandboxed MCP server gets the same cage and the same way out as an
    // agent shell: the egress proxy is its only route (the env below), and on
    // Linux its network namespace is empty except for the proxy's bridge. It
    // used to keep the host network on Linux, which made it the one caged
    // process that could reach anything.
    let proxyEnv: Record<string, string> = {};
    if (posture.effective === "sandboxed") {
      proxyEnv = await shellProxyEnv();
      const bridge = currentShellEgressBridge();
      const wrapped = posture.sandboxBackend === "seatbelt"
        ? wrapForSeatbelt(verdict.resolvedPath, this.config.args || [], undefined, "guarded", true)
        : wrapForBwrap(verdict.resolvedPath, this.config.args || [], undefined, "guarded", { network: "namespace", ...(bridge ? { bridge } : {}) });
      command = wrapped.cmd;
      spawnArgs = wrapped.args;
    } else if (isWin) {
      const wrapped = buildWindowsMcpSpawn(verdict.resolvedPath, spawnArgs);
      command = wrapped.cmd;
      spawnArgs = wrapped.args;
      windowsVerbatimArguments = wrapped.windowsVerbatimArguments;
    }
    const env = { ...buildMcpChildEnv(this.config.env, this.exemptEnvKeys), ...proxyEnv };
    let rejectSpawnFailure!: (error: Error) => void;
    const spawnFailure = new Promise<never>((_resolve, reject) => { rejectSpawnFailure = reject; });
    try {
      this.proc = spawn(command, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        shell: false,
        detached: !isWin,
        windowsVerbatimArguments,
        windowsHide: true,
      });
      const spawned = this.proc;
      spawned.once("error", (error) => {
        const failure = new Error(`MCP server ${this.serverName} failed to spawn: ${error.message}`);
        rejectSpawnFailure(failure);
        this.rejectPending(failure);
      });
      this.cleanupProc = spawned;
      this.cleanupPid = spawned.pid ?? null;

      spawned.stdout?.setEncoding("utf-8");
      spawned.stdout?.on("data", (chunk: string) => {
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

      spawned.stderr?.setEncoding("utf-8");
      spawned.stderr?.on("data", (chunk: string) => {
      // MCP servers log to stderr — only show errors, not info
      const trimmed = chunk.trim();
      if (trimmed && /error|fail|crash/i.test(trimmed)) {
        logger.warn(`[mcp:${this.serverName}] ${trimmed.slice(0, 200)}`);
      }
      });

      spawned.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        logger.warn(`[mcp:${this.serverName}] Process exited with code ${code}`);
      }
      this.rejectPending(new Error(`MCP server ${this.serverName} exited`));
      if (this.proc === spawned) this.proc = null;
      if (this.initializationComplete) this.cleanupProcess();
      });

      // Handshake
      await Promise.race([this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: "local-agent-x", version: "1.0.0" },
      }), spawnFailure]);
      this.notify("initialized", {});

      // Discover tools
      const result = await Promise.race([this.request("tools/list", {}), spawnFailure]) as { tools: MCPTool[] };
      this.tools = result.tools || [];
      this.initializationComplete = true;
      logger.info(`[mcp:${this.serverName}] Connected — ${this.tools.length} tools: ${this.tools.map(t => t.name).join(", ")}`);
    } catch (e) {
      this.disconnect();
      throw e;
    }
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

  private rejectPending(error: Error): void {
    for (const [, handler] of this.pending) {
      clearTimeout(handler.timer);
      handler.reject(error);
    }
    this.pending.clear();
  }

  private cleanupProcess(): void {
    if (process.platform !== "win32" && this.cleanupPid) killProcessGroup(this.cleanupPid, this.cleanupProc ?? undefined);
    else killProcessTree(this.cleanupProc);
    this.cleanupProc = null;
    this.cleanupPid = null;
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
  get sourceFingerprint(): string { return mcpRuntimeSourceFingerprint(this.serverName, this.trustConfig, this.config); }

  disconnect(): void {
    this.rejectPending(new Error("Disconnecting"));
    this.cleanupProcess();
    this.proc = null;
    this.initializationComplete = false;
  }

  get connected(): boolean {
    return this.proc !== null && !this.proc.killed;
  }
}
