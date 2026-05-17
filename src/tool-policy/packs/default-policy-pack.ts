/**
 * Default-policy pack — wraps the existing DEFAULT_POLICY (default-rules.ts)
 * via the ToolPolicy evaluator. Rule semantics are unchanged.
 */
import type { ToolPolicy } from "../../tool-policy.js";
import { USER_HINTS } from "../../types.js";
import { DEFAULT_POLICY } from "../default-rules.js";
import type { PolicyCall, PolicyEvalCtx, PackDecision, RulePack, RulePackRule } from "../evaluator.js";

const PACK_ID = "default-policy";
const PACK_PRIORITY = 20;

/** Describe DEFAULT_POLICY's rules in the unified shape (for introspection). */
function describeRules(): RulePackRule[] {
  return DEFAULT_POLICY.rules.map((r) => ({
    id: r.id,
    kind: r.argMatch ? "action" : "tool",
    match: { tool: r.tool, ...(r.argMatch ? { argMatch: r.argMatch } : {}), ...(r.action ? { action: r.action } : {}) },
    decision: r.decision === "confirm" ? "allow" : r.decision,
    reason: r.reason,
  }));
}

export function makeDefaultPolicyPack(toolPolicy: ToolPolicy | undefined): RulePack {
  return {
    id: PACK_ID,
    priority: PACK_PRIORITY,
    rules: describeRules(),
    evaluate(call: PolicyCall, ctx: PolicyEvalCtx): PackDecision {
      if (!toolPolicy) return { allowed: true };
      const d = toolPolicy.evaluate(call.name, call.args, ctx.sessionId);
      if (!d.allowed) {
        return {
          allowed: false,
          ruleId: d.ruleId,
          reason: d.reason,
          recovery:
            "Retrying the same call will be denied again. Read the reason — it usually points to the right alternative tool (e.g. http_request instead of bash curl).",
          userHint: d.userHint ?? USER_HINTS.policy,
        };
      }
      return { allowed: true, ruleId: d.ruleId, reason: d.reason };
    },
  };
}
