import { resolve, relative, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { SecurityDecision } from "../types.js";
import { getLaxDir } from "../lax-data-dir.js";
import { USER_HINTS } from "../types.js";
import {
  CONTEXT_RESTRICTED_TOOLS,
  WORKTREE_REQUIRED_TOOLS,
  type FileAccessMode,
  type ToolCallContext,
} from "./types.js";
import { evaluateFileAccess } from "./file-access.js";
import { evaluateShellCommand } from "./shell-policy.js";
import { evaluateWebFetch, validateUrlWithDns, type EgressMode } from "./network-policy.js";
import { TOOL_CLASS_MAP } from "../ari-kernel/tool-class-map.js";
import type { KernelClass } from "../tool-registry.js";

import { createLogger } from "../logger.js";
const logger = createLogger("security.layer-core");

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
  // true once we successfully loaded an egress-allowlist.json file from
  // disk (even if its content is `[]`). false means no file existed —
  // evaluateWebFetch uses this to distinguish "user has explicitly
  // configured an empty allowlist (deny everything)" from "no config
  // present (deny everything with a setup hint)". Previously a missing
  // file silently allowed every public host, which made the advertised
  // egress-allowlist feature fail-open on a default install.
  private egressAllowlistConfigured: boolean = false;
  private egressMode: EgressMode = "permissive";
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

  /**
   * Returns true if the target path is "user content" — either inside the
   * workspace/ subdir, or outside the repo entirely (e.g., ~/Documents,
   * ~/Desktop, /tmp, anywhere). Returns false if it's inside the repo but
   * outside workspace/ (= source code).
   *
   * Used by the worktree-isolation gate to allow content-creation workers
   * to write user artifacts (a powerpoint to workspace/, a doc to
   * ~/Documents) without requiring a sandbox — while still requiring one
   * for any write that would touch the agent's own running source.
   */
  private isUserContentPath(targetPath: string): boolean {
    if (!targetPath) return false;
    const abs = resolve(targetPath);
    // Inside workspace/ → user content
    if (abs === this.workspace || abs.startsWith(this.workspace + "/")) return true;
    // Outside the repo root entirely → user content (Documents, Desktop, /tmp, etc.)
    const repoRoot = resolve(this.workspace, "..");
    if (abs !== repoRoot && !abs.startsWith(repoRoot + "/")) return true;
    // Inside repo but not workspace/ → source code (src/, packages/, scripts/, ...)
    return false;
  }

  constructor(workspace: string, fileAccessMode?: FileAccessMode) {
    this.workspace = resolve(workspace);
    this.fileAccessMode = fileAccessMode || this.loadFileAccessMode();
    this.egressMode = this.loadEgressMode();
    // Load egress allowlist from ~/.lax/egress-allowlist.json.
    //
    // In permissive mode (default): allowlist is the "trusted destinations"
    // list — hosts the agent may send secret-shaped payloads to. Hosts not
    // listed are still reachable for plain surfing; only secret-bearing
    // POST/PUT/PATCH/DELETE bodies are gated (enforced at the tool layer).
    //
    // In strict mode: allowlist is the only set of hosts the agent may
    // reach at all. Missing file in strict mode → deny-with-hint.
    try {
      const allowlistPath = join(getLaxDir(), "egress-allowlist.json");
      if (existsSync(allowlistPath)) {
        const parsed = JSON.parse(readFileSync(allowlistPath, "utf-8"));
        if (Array.isArray(parsed)) {
          this.egressAllowlist = new Set(parsed.map((d: unknown) => String(d).toLowerCase()));
          this.egressAllowlistConfigured = true;
          logger.info(`[security] Egress allowlist loaded: ${this.egressAllowlist.size} domains (mode=${this.egressMode})`);
        } else {
          logger.warn(`[security] ${allowlistPath} is not a JSON array — treating as missing`);
        }
      } else if (this.egressMode === "strict") {
        logger.warn(
          `[security] strict mode but no allowlist at ${allowlistPath} — all outbound requests will be denied. ` +
          `Create the file with a JSON array of allowed domains or set egressMode to "permissive" in ~/.lax/security.json.`,
        );
      }
    } catch (e) {
      logger.warn(`[security] Failed to load egress allowlist: ${(e as Error).message}`);
    }
    logger.info(`[security] File access mode: ${this.fileAccessMode}`);
  }

  private loadEgressMode(): EgressMode {
    try {
      const cfgPath = join(getLaxDir(), "security.json");
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
        if (cfg.egressMode === "strict" || cfg.egressMode === "permissive") {
          return cfg.egressMode;
        }
      }
    } catch {}
    return "permissive";
  }

  private loadFileAccessMode(): FileAccessMode {
    try {
      const cfgPath = join(getLaxDir(), "security.json");
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
      const cfgPath = join(getLaxDir(), "security.json");
      let cfg: Record<string, unknown> = {};
      if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      cfg.fileAccessMode = mode;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
    } catch {}
    logger.info(`[security] File access mode changed to: ${mode}`);
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
        userHint: USER_HINTS.policy,
      };
    }

    // Delegated agents using write/edit/bash must have worktree isolation
    // IF they're modifying repo SOURCE code. Writes to user-content
    // territory (workspace/, ~/Documents, ~/Desktop, anywhere outside the
    // repo) don't need isolation — the sandbox's purpose is to protect
    // the agent's own running code from mid-task mutation, NOT to prevent
    // workers from producing user-facing artifacts. The old blanket
    // "delegated + write/edit/bash → require worktree" rule killed every
    // content-creation worker on machines where worktree provisioning
    // wasn't wired up (e.g., the polish-the-pptx case).
    //
    // For bash we keep the blanket requirement: arbitrary shell can write
    // anywhere unpredictably, no static analysis can tell us where. If a
    // worker needs bash, it needs a worktree. write/edit are the tools
    // we can reason about via their explicit `path` arg.
    if (callCtx === "delegated" && WORKTREE_REQUIRED_TOOLS.has(toolName)) {
      const sessionKey = ctx.sessionId;
      const hasWorktree = this.sessionAllowedPaths.has(sessionKey) && this.sessionAllowedPaths.get(sessionKey)!.size > 0;
      if (!hasWorktree) {
        const isContentWrite =
          (toolName === "write" || toolName === "edit") &&
          this.isUserContentPath(String(args.path || ""));
        if (!isContentWrite) {
          return {
            allowed: false,
            reason: `Blocked: delegated agent "${toolName}" requires worktree isolation for source-code paths (writes to workspace/, ~/Documents, or anywhere outside the repo don't need it)`,
            userHint: USER_HINTS.worktreeIsolation,
          };
        }
      }
    }

    let decision: SecurityDecision;

    // Per-tool explicit cases handle the tools whose ARGUMENTS carry the
    // routing signal SecurityLayer needs to gate (path, command, url).
    // Everything else falls through to class-based dispatch on the
    // kernel taxonomy declared in src/tool-registry.ts.
    if (toolName === "browser") {
      decision = this.evaluateBrowser(args);
    } else if (
      toolName === "read" ||
      toolName === "write" ||
      toolName === "edit" ||
      toolName === "delete_file"
    ) {
      decision = evaluateFileAccess(
        this.workspace,
        this.fileAccessMode,
        (rp, sid) => this.isInAllowedPaths(rp, sid),
        toolName,
        String(args.path || ""),
        ctx.sessionId,
      );
    } else if (toolName === "bash") {
      decision = evaluateShellCommand(String(args.command || ""));
    } else if (toolName === "web_fetch" || toolName === "http_request") {
      decision = evaluateWebFetch(
        this.egressAllowlist,
        this.egressAllowlistConfigured,
        String(SecurityLayer._selfPort || "7007"),
        String(args.url || ""),
        this.egressMode,
      );
    } else {
      decision = this.evaluateByKernelClass(toolName, TOOL_CLASS_MAP[toolName], args, ctx);
    }

    this.auditLog.push({ timestamp: Date.now(), tool: toolName, decision });
    return decision;
  }

  private evaluateBrowser(args: Record<string, unknown>): SecurityDecision {
    if ((args.action === "navigate" || args.action === "new_tab") && args.url) {
      const browserUrl = String(args.url);
      // Allow localhost/127.0.0.1 for browser — user's own dev servers
      try {
        const host = new URL(browserUrl).hostname;
        if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
          return { allowed: true, reason: "Browser navigation to localhost allowed" };
        }
        return evaluateWebFetch(
          this.egressAllowlist,
          this.egressAllowlistConfigured,
          String(SecurityLayer._selfPort || "7007"),
          browserUrl,
          this.egressMode,
        );
      } catch {
        return { allowed: false, reason: "Blocked: invalid URL", userHint: USER_HINTS.network };
      }
    }
    return { allowed: true, reason: "Browser action allowed" };
  }

  /**
   * Class-based dispatch for tools that aren't routed by their explicit
   * named case above. Replaces the old default-allow branch with a
   * kernel-class lookup against src/tool-registry.ts. New tools that
   * register with a known class get the right gate automatically.
   *
   * Unknown tools (not in TOOLS) fall through to a deny case unless they
   * carry an mcpServer signal — MCP-sourced tools are gated by binary-
   * integrity check at connect time + approval flow at call time, and
   * SecurityLayer participates by allowing-and-logging.
   */
  private evaluateByKernelClass(
    toolName: string,
    kernelClass: KernelClass | undefined,
    args: Record<string, unknown>,
    ctx: ToolCallContext,
  ): SecurityDecision {
    if (kernelClass === undefined) {
      if (ctx.mcpServer) {
        return {
          allowed: true,
          reason: `MCP-sourced tool from "${ctx.mcpServer}" — gated by integrity check and approval flow`,
        };
      }
      return {
        allowed: false,
        reason: `Blocked: tool "${toolName}" not in registry — register in src/tool-registry.ts`,
        userHint: USER_HINTS.policy,
      };
    }

    switch (kernelClass) {
      case "internal":
        // No raw I/O sink — gated upstream by kernel + tool-policy.
        return { allowed: true, reason: "Internal-class tool — gated by kernel/policy layers" };

      case "http":
        // No URL arg means the call's destination is hardcoded inside
        // the tool itself (e.g. email_send → Gmail API). SecurityLayer
        // cannot SSRF-check what it can't see — pass through; the
        // tool's own implementation owns the actual HTTP call.
        if (typeof args.url === "string" && args.url.length > 0) {
          return evaluateWebFetch(
            this.egressAllowlist,
            this.egressAllowlistConfigured,
            String(SecurityLayer._selfPort || "7007"),
            args.url,
            this.egressMode,
          );
        }
        return {
          allowed: true,
          reason: `${toolName}: http-class tool with no URL arg — destination is internal`,
        };

      case "shell":
        // Non-bash shell tools (process_start, install_software). bash
        // is handled by the explicit case above and is the only one
        // routed through evaluateShellCommand. The kernel and the
        // tool's own implementation are the gates for the rest.
        return {
          allowed: true,
          reason: `${toolName}: shell-class tool — gated by kernel and tool implementation`,
        };

      case "file":
        // Non-path file tools (glob, grep, view_image, ari_file). Tools
        // with a `path` arg are handled via the explicit case above.
        return {
          allowed: true,
          reason: `${toolName}: file-class tool without explicit path gate`,
        };

      case "database":
        // sql_query / sql_explain / sql_schema operate on the LAX-managed
        // SQL store. Internal-like for SecurityLayer's purposes.
        return {
          allowed: true,
          reason: `${toolName}: database-class tool — gated by kernel and tool implementation`,
        };

      case "retrieval":
        // memory_search / search_past_sessions — internal-like.
        return {
          allowed: true,
          reason: `${toolName}: retrieval-class tool — gated by kernel and tool implementation`,
        };

      case "secret-vault":
        // browser_capture_to_secret / browser_fill_from_secret /
        // clipboard_write_from_secret. High-risk but the gate that
        // matters is the secret-vault-action gate inside the Ari
        // kernel (ARI_ACTION_MAP).
        return {
          allowed: true,
          reason: `${toolName}: secret-vault-class tool — gated by Ari kernel`,
        };
    }

    // KernelClass union exhausted; unreachable but fail-closed.
    return {
      allowed: false,
      reason: `Blocked: tool "${toolName}" has unrecognized kernel class "${String(kernelClass)}"`,
      userHint: USER_HINTS.policy,
    };
  }

  /**
   * Async SSRF check with DNS pinning.
   * Resolves hostname to IP and validates the resolved address.
   * Call this for actual network requests (not just policy check).
   */
  async validateUrlWithDns(url: string): Promise<SecurityDecision> {
    return validateUrlWithDns(
      this.egressAllowlist,
      this.egressAllowlistConfigured,
      String(SecurityLayer._selfPort || "7007"),
      url,
      this.egressMode,
    );
  }

  getAuditLog() {
    return this.auditLog;
  }
}
