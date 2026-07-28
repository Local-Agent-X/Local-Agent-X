/**
 * Security-layer pack — wraps SecurityLayer.evaluate (file/shell/network/
 * context checks). Rule semantics are unchanged.
 */
import type { SecurityLayer } from "../../security/index.js";
import { CONTEXT_RESTRICTED_TOOLS, WORKTREE_REQUIRED_TOOLS } from "../../security/layer/index.js";
import { USER_HINTS } from "../../types.js";
import type { PolicyCall, PolicyEvalCtx, PackDecision, RulePack, RulePackRule } from "../evaluator.js";

const PACK_ID = "security-layer";
const PACK_PRIORITY = 10;

/** The security-block recovery line: boundary guidance PLUS the escalation
 *  invariant. This is the ONE source of truth — both the pre-dispatch pack
 *  (below) and the SC-10 egress probe (enforce-policy.ts
 *  probeUpstreamEgressBlockers) render from here so the two paths can never
 *  drift. The escalation sentence is load-bearing: a live agent that hit a
 *  FALSE-POSITIVE block read "adjust the call" alone as license to work
 *  around the block silently (hand-patching build artifacts) instead of
 *  surfacing it to the user. */
export function securityDenyRecovery(): string {
  return (
    "Adjust the call to stay within the workspace and security boundaries — retrying the same args will be denied again. " +
    "If this block is stopping a legitimate task, do not look for a workaround — stop and tell the user exactly what was blocked and why you needed it, so they can adjust settings or approve another path."
  );
}

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
          recovery: securityDenyRecovery(),
          // Same fallback the SC-10 probe uses — an undefined layer hint must
          // not drop the user-facing line on this path either.
          userHint: d.userHint ?? USER_HINTS.policy,
        };
      }
      return { allowed: true, reason: d.reason };
    },
  };
}
