/**
 * Unified policy evaluator — closes F4 from DRY-AUDIT.md.
 *
 * Four policy layers used to evaluate independently with no cross-awareness:
 *   - src/security/layer-core.ts (file/shell/network checks)
 *   - src/tool-policy/default-rules.ts (DEFAULT_POLICY allow/deny rules)
 *   - src/threat/tool-chain.ts (pre-tool-call restricted-mode check)
 *   - packages/arikernel/policy-engine/src/defaults.ts (deny-by-default backstop)
 *
 * This module unifies dispatch: each layer becomes a `RulePack` with a sealed
 * list of rules + a pack-internal evaluator. The evaluator below iterates the
 * packs in priority order, short-circuits on the first deny, and emits a
 * structured audit log entry naming the pack and rule. Rule SEMANTICS are
 * unchanged — this is a dispatcher refactor.
 */
import { z } from "zod";

import { createLogger } from "../logger.js";

const logger = createLogger("policy.evaluator");

// ── Unified rule shape (introspection + audit) ─────────────────────────

export const RulePackRuleSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "tool",          // matches by tool name / glob (default-policy)
    "action",        // matches by tool name + action (e.g. browser.evaluate)
    "shell",         // shell command checks (security layer)
    "file",          // file path checks (security layer)
    "network",       // url / host checks (security layer)
    "context",       // tool blocked in a call-context (cron / delegated)
    "rate-limit",    // per-session call cap
    "threat",        // session threat state (pre-tool-call)
    "default-deny",  // backstop — fail-closed deny
  ]),
  match: z.record(z.unknown()).optional(),
  decision: z.enum(["allow", "deny"]),
  reason: z.string(),
});

export type RulePackRule = z.infer<typeof RulePackRuleSchema>;

// ── Pack-internal evaluation surface ───────────────────────────────────

export interface PolicyCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface PolicyEvalCtx {
  sessionId: string;
  callContext: "local" | "api" | "delegated" | "cron";
}

export interface PackDeny {
  allowed: false;
  ruleId?: string;
  reason: string;
  recovery?: string;
  /** Plain-English user-facing summary; see SecurityDecision.userHint. */
  userHint?: string;
}

export interface PackAllow {
  allowed: true;
  ruleId?: string;
  reason?: string;
}

export type PackDecision = PackAllow | PackDeny;

/** Sealed pack record. `rules` is the descriptive surface (for introspection
 *  and audit); `evaluate` runs the actual decision against the pack's backing
 *  implementation. Both must agree on `id`. */
export interface RulePack {
  readonly id: string;
  readonly priority: number;
  readonly rules: readonly RulePackRule[];
  evaluate(call: PolicyCall, ctx: PolicyEvalCtx): PackDecision | Promise<PackDecision>;
}

// ── Evaluator decision ─────────────────────────────────────────────────

export interface EvaluatorDeny {
  allowed: false;
  deniedBy: { packId: string; ruleId?: string };
  reason: string;
  recovery?: string;
  /** Plain-English user-facing summary; see SecurityDecision.userHint. */
  userHint?: string;
}

export interface EvaluatorAllow {
  allowed: true;
}

export type EvaluatorDecision = EvaluatorAllow | EvaluatorDeny;

// ── Main entry: evaluate(call, packs, ctx) ─────────────────────────────

/** Iterate packs in priority order; first deny wins. Each deny emits a
 *  structured audit log entry naming the pack and rule so the existing
 *  audit trail isn't lost in the refactor. */
export async function evaluate(
  call: PolicyCall,
  packs: readonly RulePack[],
  ctx: PolicyEvalCtx,
): Promise<EvaluatorDecision> {
  const ordered = [...packs].sort((a, b) => a.priority - b.priority);
  for (const pack of ordered) {
    const decision = await pack.evaluate(call, ctx);
    if (!decision.allowed) {
      logger.info(
        `[policy] DENY pack=${pack.id}` +
          (decision.ruleId ? ` rule=${decision.ruleId}` : "") +
          ` tool=${call.name} session=${ctx.sessionId} reason=${decision.reason}`,
      );
      return {
        allowed: false,
        deniedBy: { packId: pack.id, ruleId: decision.ruleId },
        reason: decision.reason,
        recovery: decision.recovery,
        userHint: decision.userHint,
      };
    }
  }
  return { allowed: true };
}
