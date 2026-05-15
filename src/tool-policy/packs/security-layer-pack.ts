/**
 * Security-layer pack — wraps SecurityLayer.evaluate (file/shell/network/
 * context checks). Rule semantics are unchanged.
 */
import type { SecurityLayer } from "../../security.js";
import { CONTEXT_RESTRICTED_TOOLS, WORKTREE_REQUIRED_TOOLS } from "../../security/types.js";
import type { PolicyCall, PolicyEvalCtx, PackDecision, RulePack, RulePackRule } from "../evaluator.js";

const PACK_ID = "security-layer";
const PACK_PRIORITY = 10;

function describeRules(): RulePackRule[] {
  const rules: RulePackRule[] = [];
  for (const [tool, contexts] of Object.entries(CONTEXT_RESTRICTED_TOOLS)) {
    rules.push({
      id: `security.context.${tool}`,
      kind: "context",
      match: { tool, contexts },
      decision: "deny",
      reason: `Tool "${tool}" not allowed in ${contexts.join("/")} context`,
    });
  }
  for (const tool of WORKTREE_REQUIRED_TOOLS) {
    rules.push({
      id: `security.worktree-required.${tool}`,
      kind: "context",
      match: { tool, callContext: "delegated" },
      decision: "deny",
      reason: `Delegated "${tool}" requires worktree isolation`,
    });
  }
  rules.push(
    { id: "security.file-access", kind: "file", decision: "deny", reason: "Path outside allowed roots" },
    { id: "security.shell", kind: "shell", decision: "deny", reason: "Disallowed shell command" },
    { id: "security.network", kind: "network", decision: "deny", reason: "SSRF / egress blocked" },
  );
  return rules;
}

export function makeSecurityLayerPack(security: SecurityLayer | undefined): RulePack {
  return {
    id: PACK_ID,
    priority: PACK_PRIORITY,
    rules: describeRules(),
    evaluate(call: PolicyCall, ctx: PolicyEvalCtx): PackDecision {
      if (!security) return { allowed: true };
      const d = security.evaluate({
        toolName: call.name,
        args: call.args,
        sessionId: ctx.sessionId,
        callContext: ctx.callContext,
      });
      if (!d.allowed) {
        return {
          allowed: false,
          reason: d.reason,
          recovery:
            "Adjust the call to stay within the workspace and security boundaries — retrying the same args will be denied again.",
        };
      }
      return { allowed: true, reason: d.reason };
    },
  };
}
