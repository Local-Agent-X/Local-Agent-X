import type { SecurityDecision } from "../types.js";
import { USER_HINTS } from "../types.js";
import type { FileAccessMode, ToolCallContext } from "./types.js";
import { evaluateFileAccess } from "./file-access.js";
import { resolvePath as resolveSqlDbPath } from "../tools/sql-tools.js";
import { evaluateWebFetch, type EgressMode } from "./network-policy.js";
import { evaluateShellCommand } from "./shell-policy.js";
import type { KernelClass } from "../tool-registry.js";

export interface KernelClassPolicyCtx {
  egressAllowlist: ReadonlySet<string>;
  egressAllowlistConfigured: boolean;
  egressMode: EgressMode;
  selfPort: string;
  localServicePorts: ReadonlySet<string>;
  workspace: string;
  fileAccessMode: FileAccessMode;
  isInAllowedPaths: (realPath: string, sessionId?: string) => boolean;
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
export function evaluateByKernelClass(
  toolName: string,
  kernelClass: KernelClass | undefined,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  policy: KernelClassPolicyCtx,
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
          policy.egressAllowlist,
          policy.egressAllowlistConfigured,
          policy.selfPort,
          args.url,
          policy.egressMode,
          policy.localServicePorts,
        );
      }
      return {
        allowed: true,
        reason: `${toolName}: http-class tool with no URL arg — destination is internal`,
      };

    case "shell": {
      // Non-bash shell tools (process_start, ari_shell, etc.) spawn the same
      // subprocess bash does, so route them through the SAME command vetting
      // instead of an unconditional allow. Build the command string from
      // whichever form the call uses: a literal `command`, or the structured
      // `{executable, args[]}` form (synthesize it so the denylist/metachar
      // scan sees the real command). Tools with no command to inspect
      // (process_status/kill/list operate on a session_id, not a command)
      // fall through to the kernel/tool-impl gate as before.
      let command = typeof args.command === "string" ? args.command : "";
      if (!command && typeof args.executable === "string") {
        const parts = Array.isArray(args.args) ? args.args.map((a) => String(a)) : [];
        command = [args.executable, ...parts].join(" ");
      }
      if (command) {
        return evaluateShellCommand(command);
      }
      return {
        allowed: true,
        reason: `${toolName}: shell-class tool with no command arg — gated by kernel and tool implementation`,
      };
    }

    case "file":
      // Every file-class tool opens a caller-supplied path, so it MUST declare
      // its path arg(s) in TOOL_PATH_ARGS — SecurityLayer.evaluate() then gates
      // them through evaluateFileAccess BEFORE class dispatch, and the call
      // never reaches here. Arriving here means a file-class tool shipped
      // without a pathArgs declaration: that is exactly the confinement bypass
      // this refactor closed, so fail closed rather than rubber-stamp it.
      return {
        allowed: false,
        reason: `Blocked: file-class tool "${toolName}" has no declared path arg — add pathArgs in src/tool-policy/tool-policies.data.ts so its file access is confined.`,
        userHint: USER_HINTS.fileSystem,
      };

    case "database": {
      // sql_* open a CALLER-SUPPLIED path (args.database) directly — not a
      // confined managed store (unlike ari_database/ari_sqlite_database,
      // whose store path is internal). Gate it through the read/write file-
      // access policy. Mutations gate as a write; else read. Normalize with
      // the EXACT helper the tool opens with (resolveSqlDbPath): evaluate-
      // FileAccess only does resolve(), so a divergent ~ expansion would let
      // the validated path differ from the opened path and bypass it (TOCTOU).
      const rawDb = typeof args.database === "string" ? args.database : "";
      if (rawDb) {
        const action = toolName === "sql_query" && args.readonly === false ? "write" : "read";
        return evaluateFileAccess(
          policy.workspace,
          policy.fileAccessMode,
          (rp, sid) => policy.isInAllowedPaths(rp, sid),
          action,
          resolveSqlDbPath(rawDb),
          ctx.sessionId,
        );
      }
      // No caller path → internal managed store (ari_*). Gated by kernel.
      return {
        allowed: true,
        reason: `${toolName}: managed-store database tool — gated by kernel`,
      };
    }

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
