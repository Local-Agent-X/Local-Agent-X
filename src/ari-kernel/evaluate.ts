// Evaluate a tool call through AriKernel.
// Returns { allowed, reason } — same shape as SecurityLayer.evaluate().

import { createLogger } from "../logger.js";
import { USER_HINTS } from "../types.js";
import { getFirewall, isAriRequired } from "./state.js";
import { TOOL_CLASS_MAP } from "./tool-class-map.js";
import { lookupHostGrantId } from "./grants.js";

const logger = createLogger("ari-kernel");

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
): Promise<{ allowed: boolean; reason: string; quarantined?: boolean; userHint?: string }> {
  const firewall = getFirewall();
  if (!firewall) {
    if (isAriRequired()) {
      return { allowed: false, reason: "AriKernel required but not active — tool call blocked", userHint: USER_HINTS.policy };
    }
    return { allowed: true, reason: "AriKernel not active" };
  }

  // Fail-closed on unmapped tools. Pre-2026-05-20 the fallback was a silent
  // "shell" routing that occasionally allowed if a shell grant happened to be
  // in scope — the actual injection-bypass risk. Now: unmapped → explicit
  // block with a "classify me" hint.
  if (TOOL_CLASS_MAP[toolName] === undefined) {
    return {
      allowed: false,
      reason: `[ARI] ${toolName} not in TOOL_CLASS_MAP — fail-closed. Classify it (file/http/shell/database/retrieval/secret-vault/internal) in src/ari-kernel/tool-class-map.ts.`,
      userHint: USER_HINTS.policy,
    };
  }

  const toolClass = TOOL_CLASS_MAP[toolName];
  const effectiveAction = SECRET_VAULT_ACTION_MAP[toolName] ?? action;

  try {
    const execRequest: Record<string, unknown> = {
      toolClass: toolClass as unknown,
      action: effectiveAction,
      parameters: params,
    };
    const grantId = lookupHostGrantId(toolClass, effectiveAction);
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
      return {
        allowed: false,
        reason: `[ARI] ${result.error || "Denied by kernel policy"}`,
        userHint: USER_HINTS.policy,
      };
    }

    return { allowed: true, reason: "ARI allowed" };
  } catch (e) {
    if (isAriRequired()) {
      logger.warn(`[ari] Tool call blocked due to ARI error (ariRequired=true): ${(e as Error).message}`);
      return { allowed: false, reason: "ARI error — tool call blocked (ariRequired mode)", userHint: USER_HINTS.policy };
    }
    return { allowed: true, reason: "ARI error (fail-open, built-in security active)" };
  }
}
