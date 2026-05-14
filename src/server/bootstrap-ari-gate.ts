/**
 * Translates AriKernel `ToolCall` shapes into SAX tool calls and routes them
 * through the shared `assertToolCallAllowed` chain. Wired into AriKernel
 * tool-executors at boot via `setPreDispatchGate`. Closes F3 (DRY-AUDIT.md).
 *
 * AriKernel ToolCall uses {toolClass, action}; SAX tool names are singular
 * ("read", "write", "bash"). The mapping below is best-effort — when a SAX
 * tool name can't be derived (e.g. http+get is one of http_request/web_fetch/
 * browser), we pick the most-locked-down equivalent so policy errs strict.
 */
import type { ToolCall } from "@arikernel/core";
import { setPreDispatchGate } from "@arikernel/tool-executors";
import type { SecurityLayer } from "../security.js";
import type { ToolPolicy } from "../tool-policy.js";
import { assertToolCallAllowed } from "../tools/pre-dispatch.js";

function mapToolName(toolClass: string, action: string): string {
  if (toolClass === "file") {
    if (action === "read") return "read";
    if (action === "write") return "write";
    return "edit";
  }
  if (toolClass === "shell") return "bash";
  if (toolClass === "http") return "http_request";
  if (toolClass === "database") return "memory_save";
  if (toolClass === "retrieval") return "memory_search";
  return `${toolClass}_${action}`;
}

export function wireAriPreDispatch(security: SecurityLayer, toolPolicy?: ToolPolicy): void {
  setPreDispatchGate(async (tc: ToolCall) => {
    const name = mapToolName(tc.toolClass, tc.action);
    const args = (tc.parameters || {}) as Record<string, unknown>;
    await assertToolCallAllowed(
      { id: tc.id, name, args },
      {
        sessionId: tc.runId || "ari-default",
        callContext: "delegated",
        security,
        toolPolicy,
      },
    );
  });
}
