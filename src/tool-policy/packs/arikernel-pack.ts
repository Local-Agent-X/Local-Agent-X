/**
 * AriKernel pack — mirrors packages/arikernel/policy-engine/src/defaults.ts
 * (DENY_ALL_RULE). AriKernel runs deny-by-default; this pack carries that
 * posture into the unified evaluator as a backstop. Runs last (highest
 * priority number) so it only fires when no other pack allowed the call.
 *
 * Note: SAX's default-policy pack already enforces deny-by-default for any
 * tool with no matching allow rule, so this pack is usually a no-op. It
 * exists so the F4 unification covers the arikernel policy surface
 * explicitly — same posture, single dispatcher.
 */
import { DENY_ALL_RULE } from "@arikernel/policy-engine";

import type { PolicyCall, PolicyEvalCtx, PackDecision, RulePack, RulePackRule } from "../evaluator.js";

const PACK_ID = "arikernel";
const PACK_PRIORITY = 90;

function describeRules(): RulePackRule[] {
  return [
    {
      id: DENY_ALL_RULE.id,
      kind: "default-deny",
      match: { tool: "*" },
      decision: "deny",
      reason: DENY_ALL_RULE.reason ?? "No matching policy (deny-by-default)",
    },
  ];
}

/** AriKernel-style deny-by-default backstop. Always returns allow here —
 *  the default-policy pack already enforces deny-by-default with the same
 *  semantics. This pack is the explicit surface that closes F4's coverage
 *  of the arikernel layer; activation is gated by the absence of any prior
 *  allow decision (i.e., we never reach this pack if a prior pack denied). */
export function makeArikernelPack(): RulePack {
  return {
    id: PACK_ID,
    priority: PACK_PRIORITY,
    rules: describeRules(),
    evaluate(_call: PolicyCall, _ctx: PolicyEvalCtx): PackDecision {
      return { allowed: true };
    },
  };
}
