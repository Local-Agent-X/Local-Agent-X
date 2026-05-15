/**
 * Translates AriKernel `ToolCall` shapes into SAX tool calls and routes them
 * through the shared `assertToolCallAllowed` chain. Wired into AriKernel
 * tool-executors at boot via `setPreDispatchGate`. Closes F3 (DRY-AUDIT.md).
 *
 * AriKernel ToolCall uses {toolClass, action}; SAX tool names are singular
 * ("read", "write", "bash"). The mapping below is best-effort — when a SAX
 * tool name can't be derived (e.g. http+get is one of http_request/web_fetch/
 * browser), we pick the most-locked-down equivalent so policy errs strict.
 *
 * Also wires the AriKernel `Pipeline.intercept` step at line 353 through the
 * SAX-side unified policy evaluator (rule packs from 2C.2). Closes the
 * follow-up flagged in docs/dry-repair-reports/2C.2.md — pipeline.ts:353
 * previously skipped the consolidated SAX rule packs and only ran the typed
 * `PolicyEngine.evaluate`. Now it consults both, in series.
 */
import type { ToolCall } from "@arikernel/core";
import { setPreDispatchGate, setUnifiedPolicyPreCheck } from "@arikernel/tool-executors";
import type { SecurityLayer } from "../security.js";
import type { ToolPolicy } from "../tool-policy.js";
import { assertToolCallAllowed } from "../tools/pre-dispatch.js";
import { evaluate as evaluatePolicy, type RulePack } from "../tool-policy/evaluator.js";
import { makeSecurityLayerPack } from "../tool-policy/packs/security-layer-pack.js";
import { makeDefaultPolicyPack } from "../tool-policy/packs/default-policy-pack.js";
import { makeThreatEnginePack } from "../tool-policy/packs/threat-engine-pack.js";
import { makeArikernelPack } from "../tool-policy/packs/arikernel-pack.js";

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

  // Wire the AriKernel Pipeline.intercept pre-check (item 5 from 2C.3):
  // the kernel-side typed PolicyEngine.evaluate now runs in series with
  // the SAX unified evaluator, so the same rule packs that gate chat-path
  // calls also gate kernel-side tool calls. The typed PolicyEngine still
  // runs second to enforce capability tokens / taint rules.
  setUnifiedPolicyPreCheck(async (tc: ToolCall) => {
    const name = mapToolName(tc.toolClass, tc.action);
    const args = (tc.parameters || {}) as Record<string, unknown>;
    const packs: RulePack[] = [
      makeSecurityLayerPack(security),
      makeDefaultPolicyPack(toolPolicy),
      makeThreatEnginePack(undefined),
      makeArikernelPack(),
    ];
    const decision = await evaluatePolicy(
      { id: tc.id, name, args },
      packs,
      { sessionId: tc.runId || "ari-default", callContext: "delegated" },
    );
    if (!decision.allowed) {
      return { allowed: false, reason: decision.reason };
    }
    return { allowed: true };
  });
}
