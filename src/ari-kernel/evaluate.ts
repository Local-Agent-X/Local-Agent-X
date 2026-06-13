// Evaluate a tool call through AriKernel.
// Returns { allowed, reason } — same shape as SecurityLayer.evaluate().

import { createLogger } from "../logger.js";
import { USER_HINTS } from "../types.js";
import { getFirewall, isAriRequired } from "./state.js";
import { kernelClassForTool, isMcpToolName } from "./tool-class-map.js";
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
        reason: `[ARI kernel] ${result.error || "Denied by kernel policy"}`,
        userHint: USER_HINTS.kernel,
      };
    }

    return { allowed: true, reason: "ARI allowed" };
  } catch (e) {
    if (isAriRequired()) {
      logger.warn(`[ari] Tool call blocked due to ARI error (ariRequired=true): ${(e as Error).message}`);
      // Surface the underlying error IN the result the model sees. The
      // generic "ARI error" alone sent the agent diagnosing tool-policy.json
      // while the actual cause ("Unknown action 'exec' for tool class
      // 'http'" — a missing ARI_ACTION_MAP entry) sat only in this log.
      // Single-line + capped: zod errors arrive as multi-line JSON arrays.
      const detail = ((e as Error).message || String(e)).replace(/\s+/g, " ").slice(0, 300);
      return {
        allowed: false,
        reason: `[ARI kernel] evaluation error, blocked in ariRequired mode: ${detail}`,
        userHint: USER_HINTS.kernel,
      };
    }
    return { allowed: true, reason: "ARI error (fail-open, built-in security active)" };
  }
}
