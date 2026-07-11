// Evaluate a tool call through AriKernel.
// Returns { allowed, reason } — same shape as SecurityLayer.evaluate().

import { createLogger } from "../logger.js";
import { USER_HINTS } from "../types.js";
import { isAriRequired } from "./state.js";
import { kernelClassForTool, isMcpToolName } from "./tool-class-map.js";
import { lookupHostGrantId } from "./grants.js";
import { ensureAriKernelScope, refreshAriKernelScope } from "./lifecycle.js";
import { isSensitivePath } from "../data-lineage/index.js";
import { resolveAgentPath } from "../workspace/paths.js";

const logger = createLogger("ari-kernel");

// The kernel's sensitive-file TRIGGER reason: THIS file action was flagged
// sensitive by a behavioral rule (and quarantined the run). Deliberately does
// NOT match the cascade ("entered restricted mode … N denied sensitive actions")
// — the cascade means a PRIOR action already quarantined, and overriding on it
// would let a benign write CLEAR a genuine quarantine.
const KERNEL_SENSITIVE_FILE_TRIGGER = /sensitive file|behavioral rule/i;
const KERNEL_FOREIGN_TAINT_TRIGGER = /shell execution with untrusted input is forbidden/i;

function filePathFromParams(params: Record<string, unknown>): string | null {
  const p = params.path ?? params.file_path ?? params.filePath ?? params.target;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/**
 * Is a kernel file-denial a FALSE POSITIVE of its unanchored sensitive-file
 * substring rule? The ARI runtime flags a path as a "sensitive file" by
 * substring (/password|credential|token|secret|.env|id_rsa/) — the crude match
 * LAX's own detector abandoned for anchored basename/extension/cred-dir shapes.
 * True only when (a) the reason is the sensitive-file TRIGGER (not the
 * restricted-mode cascade) AND (b) LAX's canonical, anchored isSensitivePath
 * says the path is NOT a genuine secret. Genuine secret files (~/.ssh/id_rsa,
 * .env, ~/.aws/credentials) return false here → the kernel's denial stands.
 */
export function isKernelSensitiveFileFalsePositive(
  reason: string,
  params: Record<string, unknown>,
): boolean {
  if (!KERNEL_SENSITIVE_FILE_TRIGGER.test(reason)) return false;
  const path = filePathFromParams(params);
  if (!path) return false;
  return !isSensitivePath(resolveAgentPath(path));
}

// Per-tool action override: secret-vault tools have a fixed action mapping
// (capture / fill / clipboard) regardless of what the executor passes in.
// ARI sees the canonical action in audit logs and behavioral rules.
const SECRET_VAULT_ACTION_MAP: Record<string, string> = {
  browser_capture_to_secret: "capture",
  browser_fill_from_secret: "fill",
  clipboard_write_from_secret: "clipboard",
};

export async function ariEvaluate(
  toolName: string,
  action: string,
  params: Record<string, unknown>,
  taintLabels?: string[],
  scopeId?: string,
  retriedAfterForeignTaint = false,
): Promise<{ allowed: boolean; reason: string; quarantined?: boolean; userHint?: string }> {
  const firewall = ensureAriKernelScope(scopeId);
  if (!firewall) {
    if (isAriRequired()) {
      return { allowed: false, reason: "[ARI kernel] required but not active — tool call blocked", userHint: USER_HINTS.kernel };
    }
    return { allowed: true, reason: "AriKernel not active" };
  }

  // Fail-closed on unmapped tools. Pre-2026-05-20 the fallback was a silent
  // "shell" routing that occasionally allowed if a shell grant happened to be
  // in scope — the actual injection-bypass risk. Now: unmapped → explicit
  // block with a "classify me" hint.
  const toolClass = kernelClassForTool(toolName);
  if (toolClass === undefined) {
    return {
      allowed: false,
      reason: `[ARI kernel] ${toolName} not in TOOL_CLASS_MAP — fail-closed. Classify it (file/http/shell/database/retrieval/secret-vault/internal) in src/ari-kernel/tool-class-map.ts.`,
      userHint: USER_HINTS.kernel,
    };
  }

  // MCP tools resolve to the "http" class but arrive with the dispatcher's
  // default "exec" action, which is invalid for http. Map them to "get" so they
  // get the SAME kernel treatment as the agent's existing read-class http tools
  // (web_fetch / web_search): the default workspace-assistant preset allows them
  // (allow-http-get) and any taint rules a stricter preset adds apply uniformly.
  // (A blanket "post" would trip deny-http-write and block every MCP call —
  // exactly the same limitation the agent's own http_request POST has under that
  // preset. Whether to permit outbound MCP/http writes is a preset/profile
  // decision, not something this mapping should silently force.)
  const effectiveAction =
    SECRET_VAULT_ACTION_MAP[toolName] ?? (isMcpToolName(toolName) ? "get" : action);

  try {
    const execRequest: Record<string, unknown> = {
      toolClass: toolClass as unknown,
      action: effectiveAction,
      parameters: params,
    };
    const grantId = lookupHostGrantId(toolClass, effectiveAction, scopeId);
    if (grantId) execRequest.grantId = grantId;
    if (taintLabels && taintLabels.length > 0) {
      execRequest.taintLabels = taintLabels.map(label => ({
        source: String(label),
        origin: "agent" as const,
        confidence: 1.0,
        addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      }));
    }
    const result = await firewall.execute(execRequest as unknown as Parameters<typeof firewall.execute>[0]);

    if (!result.success) {
      const reason = result.error || "Denied by kernel policy";
      // Sensitive-file false-positive rescue. Writing a normally-named source
      // file (passwordReset.ts, tokenStore.ts, authGuard.ts) trips the kernel's
      // unanchored substring rule, gets DENIED, and QUARANTINES the whole run
      // into read-only — bricking every later edit + the build verify for the
      // rest of the op. Honor the kernel's sensitive-file verdict only when LAX's
      // canonical (anchored) detector AGREES the path is a real secret; when it
      // disagrees, allow the write and refresh the run so the bogus quarantine
      // doesn't cascade. A genuine secret read still quarantines (see the
      // TRIGGER-not-cascade scoping in isKernelSensitiveFileFalsePositive).
      if (toolClass === "file" && isKernelSensitiveFileFalsePositive(reason, params)) {
        logger.warn(
          `[ari] sensitive-file FALSE POSITIVE — kernel flagged benign source path ` +
          `"${filePathFromParams(params)}" (LAX isSensitivePath=false); overriding deny ` +
          `+ refreshing run to clear the bogus quarantine`,
        );
        refreshAriKernelScope(scopeId);
        return {
          allowed: true,
          reason: "ARI sensitive-file false positive on a benign source path — overridden by LAX canonical detector",
        };
      }
      return {
        allowed: false,
        reason: `[ARI kernel] ${reason}`,
        userHint: USER_HINTS.kernel,
      };
    }

    return { allowed: true, reason: "ARI allowed" };
  } catch (e) {
    const rawDetail = (e as Error).message || String(e);
    // Compatibility rescue for the default/ad-hoc scope, where unrelated calls
    // can still share one firewall. Canonical operations pass an operation scope
    // and are isolated before reaching this branch.
    if (
      !retriedAfterForeignTaint &&
      (!taintLabels || taintLabels.length === 0) &&
      KERNEL_FOREIGN_TAINT_TRIGGER.test(rawDetail) &&
      refreshAriKernelScope(scopeId)
    ) {
      logger.warn(
        `[ari] foreign run-level taint detected on clean call — refreshed ARI scope and retrying once`,
      );
      return ariEvaluate(toolName, action, params, taintLabels, scopeId, true);
    }
    if (isAriRequired()) {
      logger.warn(`[ari] Tool call blocked due to ARI error (ariRequired=true): ${rawDetail}`);
      // Surface the underlying error IN the result the model sees. The
      // generic "ARI error" alone sent the agent diagnosing tool-policy.json
      // while the actual cause ("Unknown action 'exec' for tool class
      // 'http'" — a missing ARI_ACTION_MAP entry) sat only in this log.
      // Single-line + capped: zod errors arrive as multi-line JSON arrays.
      const detail = rawDetail.replace(/\s+/g, " ").slice(0, 300);
      return {
        allowed: false,
        reason: `[ARI kernel] evaluation error, blocked in ariRequired mode: ${detail}`,
        userHint: USER_HINTS.kernel,
      };
    }
    return { allowed: true, reason: "ARI error (fail-open, built-in security active)" };
  }
}
