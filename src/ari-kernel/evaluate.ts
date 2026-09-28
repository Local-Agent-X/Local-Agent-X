// Evaluate a tool call through AriKernel.
// Returns { allowed, reason } — same shape as SecurityLayer.evaluate().

import { createLogger } from "../logger.js";
import { USER_HINTS } from "../types.js";
import { isAriRequired } from "./state.js";
import { kernelClassForTool, isMcpToolName } from "./tool-class-map.js";
import { lookupHostGrantId } from "./grants.js";
import { ensureAriKernelScope, refreshAriKernelScope } from "./lifecycle.js";
import type { KernelQuarantine } from "../types.js";
import { readKernelQuarantine } from "./quarantine.js";

const logger = createLogger("ari-kernel");

export interface AriVerdict {
  allowed: boolean;
  reason: string;
  userHint?: string;
  /** The run state behind a deny, when a run rule refused this call or the
   *  scope is restricted — the rule that fired and whether this call raised
   *  it or merely ran into it. */
  quarantine?: KernelQuarantine;
}

const KERNEL_FOREIGN_TAINT_TRIGGER = /shell execution with untrusted input is forbidden/i;

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
): Promise<AriVerdict> {
  const firewall = ensureAriKernelScope(scopeId);
  // Restricted BEFORE this call ran → any deny below is a cascade, not a rule
  // this call tripped; readKernelQuarantine stamps the trigger accordingly.
  const restrictedBefore = readKernelQuarantine(scopeId, false) !== null;
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
      return withQuarantine({
        allowed: false,
        reason: `[ARI kernel] ${reason}`,
        userHint: USER_HINTS.kernel,
      }, scopeId, restrictedBefore);
    }

    return { allowed: true, reason: "ARI allowed" };
  } catch (e) {
    const rawDetail = (e as Error).message || String(e);
    // A behavioral-rule quarantine is thrown, not returned (denyQuarantinedAction),
    // so it lands here — and read literally as "evaluation error" it sent two
    // live turns chasing an engine fault; the quarantine is named below.
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
      const verdict = withQuarantine({
        allowed: false,
        reason: `[ARI kernel] evaluation error, blocked in ariRequired mode: ${detail}`,
        userHint: USER_HINTS.kernel,
      }, scopeId, restrictedBefore);
      // A quarantine is a verdict, not an error: name the rule and its reason
      // instead of the generic "evaluation error" the thrown deny arrives as.
      if (verdict.quarantine) {
        const q = verdict.quarantine;
        const what = q.trigger === "restricted"
          ? `run restricted since ${q.restrictedAt} by ${q.rule ?? q.trigger} (${q.reason}); ${detail}`
          : q.trigger === "behavioral_rule"
            ? `run rule ${q.rule} refused this call: ${q.reason}. The run continues: ${q.deniedActions} of ${q.threshold} denials before it is restricted to read-only actions.`
            : `${q.rule ?? q.trigger} fired: ${q.reason}. ${detail}`;
        verdict.reason = `[ARI kernel] ${what}`;
      }
      return verdict;
    }
    return { allowed: true, reason: "ARI error (fail-open, built-in security active)" };
  }
}

function withQuarantine(verdict: AriVerdict, scopeId: string | undefined, restrictedBefore: boolean): AriVerdict {
  const quarantine = readKernelQuarantine(scopeId, !restrictedBefore, verdict.reason);
  return quarantine ? { ...verdict, quarantine } : verdict;
}
