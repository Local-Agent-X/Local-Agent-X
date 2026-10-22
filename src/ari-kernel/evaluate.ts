// Evaluate a tool call through AriKernel.
// Returns { allowed, reason } — same shape as SecurityLayer.evaluate().

import { ToolCallDeniedError } from "@arikernel/core";
import { createLogger } from "../logger.js";
import { USER_HINTS } from "../types.js";
import { isAriRequired } from "./state.js";
import { kernelClassForTool } from "./tool-class-map.js";
import { lookupHostGrantId } from "./grants.js";
import { ensureAriKernelScope, refreshAriKernelScope } from "./lifecycle.js";
import type { KernelQuarantine } from "../types.js";
import { readKernelQuarantine } from "./quarantine.js";
import { ariActionOf, isMcpServerTool, policyRowOf } from "../tool-registry.js";

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

export async function ariEvaluate(
  toolName: string,
  action: string,
  params: Record<string, unknown>,
  taintLabels?: string[],
  scopeId?: string,
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

  // A secret-vault tool is judged as its row's fixed action (capture / fill /
  // clipboard) whatever the caller passes, so ARI sees the canonical action in
  // audit logs and behavioral rules. An MCP server tool has no row, so a
  // caller that reads the action off the rows hands the shell's "exec"
  // fallthrough; its action is derived here from the server's own facts
  // (tool-registry ariActionOf): a write unless the server marked it
  // read-only, so a tainted create or delete is a tainted write.
  const vaultAction = toolClass === "secret-vault" ? policyRowOf(toolName)?.ariAction : undefined;
  const effectiveAction = typeof vaultAction === "string" ? vaultAction
    : isMcpServerTool(toolName) ? ariActionOf(toolName, params)
    : action;

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
    // The kernel delivers every policy deny, run-rule refusal and quarantine by
    // THROWING ToolCallDeniedError (firewall/execution.ts rethrows it). That is
    // a verdict, not an engine fault, so it blocks whether or not the kernel is
    // required. Before this split an optional kernel (ariRequired=false) turned
    // every deny into the fail-open branch below.
    const isDeny = isKernelDeny(e);
    if (!isDeny && !isAriRequired()) {
      return { allowed: true, reason: "ARI error (fail-open, built-in security active)" };
    }
    if (!isDeny) logger.warn(`[ari] Tool call blocked due to ARI error (ariRequired=true): ${rawDetail}`);
    // Surface the underlying error IN the result the model sees. The generic
    // "ARI error" alone sent the agent diagnosing tool-policy.json while the
    // actual cause ("Unknown action 'exec' for tool class 'http'" — a missing
    // ARI_ACTION_MAP entry) sat only in this log. Single-line + capped: zod
    // errors arrive as multi-line JSON arrays.
    const detail = rawDetail.replace(/\s+/g, " ").slice(0, 300);
    const verdict = withQuarantine({
      allowed: false,
      reason: isDeny
        ? `[ARI kernel] ${detail}`
        : `[ARI kernel] evaluation error, blocked in ariRequired mode: ${detail}`,
      userHint: USER_HINTS.kernel,
    }, scopeId, restrictedBefore);
    // A quarantine names the rule and its reason instead of the raw deny text.
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
}

// instanceof first; the name check covers a second copy of @arikernel/core
// (vitest aliases, a worktree's own node_modules) whose class identity differs.
function isKernelDeny(e: unknown): boolean {
  return e instanceof ToolCallDeniedError || (e as { name?: unknown } | null)?.name === "ToolCallDeniedError";
}

function withQuarantine(verdict: AriVerdict, scopeId: string | undefined, restrictedBefore: boolean): AriVerdict {
  const quarantine = readKernelQuarantine(scopeId, !restrictedBefore, verdict.reason);
  return quarantine ? { ...verdict, quarantine } : verdict;
}
