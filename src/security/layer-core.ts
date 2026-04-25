import { resolve, relative, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import type { SecurityDecision } from "../types.js";
import {
  CONTEXT_RESTRICTED_TOOLS,
  WORKTREE_REQUIRED_TOOLS,
  type FileAccessMode,
  type ToolCallContext,
} from "./types.js";
import { evaluateFileAccess } from "./file-access.js";
import { evaluateShellCommand } from "./shell-policy.js";
import { evaluateWebFetch, validateUrlWithDns } from "./network-policy.js";

/**
 * Security layer that evaluates tool calls before execution.
 * Principles:
 * - Fail closed: ambiguity → block
 * - Defense in depth: multiple validation stages
 * - DNS pinning: resolve hostname, then validate resolved IP
 * - No shell metacharacters: reject, don't escape
 * - Path normalization: realpath before checking
 */
export class SecurityLayer {
  /** Port the server is running on — set at startup so SSRF can whitelist self-calls */
  static _selfPort: string = "7007";

  private workspace: string;
  private auditLog: Array<{ timestamp: number; tool: string; decision: SecurityDecision }> = [];
  private egressAllowlist: Set<string> = new Set();
  private sessionAllowedPaths = new Map<string, Set<string>>();
  fileAccessMode: FileAccessMode = "common";

  /** Allow an additional path for a specific session (e.g., agent worktree) */
  addAllowedPath(p: string, sessionId?: string): void {
    const key = sessionId || "_global";
    if (!this.sessionAllowedPaths.has(key)) this.sessionAllowedPaths.set(key, new Set());
    this.sessionAllowedPaths.get(key)!.add(resolve(p));
  }
  removeAllowedPath(p: string, sessionId?: string): void {
    const key = sessionId || "_global";
    this.sessionAllowedPaths.get(key)?.delete(resolve(p));
  }
  /** Check if a path is in the allowed set for a session */
  private isInAllowedPaths(realPath: string, sessionId?: string): boolean {
    const check = (key: string) => {
      const paths = this.sessionAllowedPaths.get(key);
      return paths ? [...paths].some(p => !relative(p, realPath).startsWith("..")) : false;
    };
    return check(sessionId || "_global") || check("_global");
  }

  constructor(workspace: string, fileAccessMode?: FileAccessMode) {
    this.workspace = resolve(workspace);
    this.fileAccessMode = fileAccessMode || this.loadFileAccessMode();
    // Load egress allowlist from ~/.sax/egress-allowlist.json
    try {
      const allowlistPath = join(homedir(), ".lax", "egress-allowlist.json");
      if (existsSync(allowlistPath)) {
        const domains: string[] = JSON.parse(readFileSync(allowlistPath, "utf-8"));
        this.egressAllowlist = new Set(domains.map((d: string) => d.toLowerCase()));
        console.log(`[security] Egress allowlist loaded: ${this.egressAllowlist.size} domains`);
      }
      // If no file exists, allowlist is empty = all public domains allowed (backwards compatible)
    } catch (e) {
      console.warn(`[security] Failed to load egress allowlist: ${(e as Error).message}`);
    }
    console.log(`[security] File access mode: ${this.fileAccessMode}`);
  }

  private loadFileAccessMode(): FileAccessMode {
    try {
      const cfgPath = join(homedir(), ".lax", "security.json");
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
        if (["workspace", "common", "unrestricted"].includes(cfg.fileAccessMode)) {
          return cfg.fileAccessMode;
        }
      }
    } catch {}
    return "common"; // Default
  }

  setFileAccessMode(mode: FileAccessMode): void {
    this.fileAccessMode = mode;
    try {
      const cfgPath = join(homedir(), ".lax", "security.json");
      let cfg: Record<string, unknown> = {};
      if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      cfg.fileAccessMode = mode;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
    } catch {}
    console.log(`[security] File access mode changed to: ${mode}`);
  }

  evaluate(ctx: ToolCallContext): SecurityDecision {
    const { toolName, args } = ctx;

    // Context-based tool tiering: block tools in restricted contexts
    const callCtx = ctx.callContext || "local";
    const restricted = CONTEXT_RESTRICTED_TOOLS[toolName];
    if (restricted && restricted.includes(callCtx)) {
      return {
        allowed: false,
        reason: `Blocked: tool "${toolName}" is not allowed in ${callCtx} context`,
      };
    }

    // Delegated agents using write/edit/bash must have worktree isolation.
    // Agents with worktrees have an entry in sessionAllowedPaths (added by server.ts).
    // Codex agents are skipped for worktree creation, so they won't have one.
    if (callCtx === "delegated" && WORKTREE_REQUIRED_TOOLS.has(toolName)) {
      const sessionKey = ctx.sessionId;
      const hasWorktree = this.sessionAllowedPaths.has(sessionKey) && this.sessionAllowedPaths.get(sessionKey)!.size > 0;
      if (!hasWorktree) {
        return {
          allowed: false,
          reason: `Blocked: delegated agent "${toolName}" requires worktree isolation (not available for this provider)`,
        };
      }
    }

    let decision: SecurityDecision;

    switch (toolName) {
      case "read":
      case "write":
      case "edit":
        decision = evaluateFileAccess(
          this.workspace,
          this.fileAccessMode,
          (rp, sid) => this.isInAllowedPaths(rp, sid),
          toolName,
          String(args.path || ""),
          ctx.sessionId,
        );
        break;
      case "bash":
        decision = evaluateShellCommand(String(args.command || ""));
        break;
      case "web_fetch":
      case "http_request":
        decision = evaluateWebFetch(this.egressAllowlist, String(SecurityLayer._selfPort || "7007"), String(args.url || ""));
        break;
      case "browser":
        if ((args.action === "navigate" || args.action === "new_tab") && args.url) {
          const browserUrl = String(args.url);
          // Allow localhost/127.0.0.1 for browser — user's own dev servers
          try {
            const host = new URL(browserUrl).hostname;
            if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
              decision = { allowed: true, reason: "Browser navigation to localhost allowed" };
            } else {
              decision = evaluateWebFetch(this.egressAllowlist, String(SecurityLayer._selfPort || "7007"), browserUrl);
            }
          } catch {
            decision = { allowed: false, reason: "Blocked: invalid URL" };
          }
        } else {
          decision = { allowed: true, reason: "Browser action allowed" };
        }
        break;
      default:
        decision = { allowed: true, reason: "Unknown tool — allowed by default" };
    }

    this.auditLog.push({ timestamp: Date.now(), tool: toolName, decision });
    return decision;
  }

  /**
   * Async SSRF check with DNS pinning.
   * Resolves hostname to IP and validates the resolved address.
   * Call this for actual network requests (not just policy check).
   */
  async validateUrlWithDns(url: string): Promise<SecurityDecision> {
    return validateUrlWithDns(this.egressAllowlist, String(SecurityLayer._selfPort || "7007"), url);
  }

  getAuditLog() {
    return this.auditLog;
  }
}
