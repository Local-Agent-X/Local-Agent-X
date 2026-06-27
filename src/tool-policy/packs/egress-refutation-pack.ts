/**
 * Egress-refutation pack — an autonomous safety net for HIGH-STAKES,
 * IRREVERSIBLE egress (sending email, DMing a third party, shipping a file
 * off-box) performed WHILE NO HUMAN IS PRESENT (cron / api / delegated
 * sub-agents). Before such a send fires, this pack runs independent LLM
 * skeptics (via verifyByRefutation) at the action; a strict-majority "refuted"
 * verdict blocks it.
 *
 * Interactive sessions (callContext "local") are a deliberate no-op: the
 * approval prompt already covers a human-supervised send, so the LLM latency
 * stays OUT of the interactive path. Everything that isn't an autonomous,
 * high-stakes, irreversible egress is a cheap pass-through.
 *
 * Fail-OPEN by design: "holds" / "inconclusive" / classifier-unavailable all
 * ALLOW. This pack only ever ADDS a deny on a confident refutation — the other
 * gates (security, default-policy, threat, kernel) still apply underneath it.
 * Runs late (high priority number) so the cheaper, deterministic gates short-
 * circuit first; the isHighStakesEgress predicate is the real cost guard before
 * any voter fires.
 */
import { hasCapability } from "../../tool-registry.js";
import { destructiveOperationReason } from "../../approval-decision.js";
import { verifyByRefutation } from "../../classifiers/verify-by-refutation.js";
import { USER_HINTS } from "../../types.js";
import type { PolicyCall, PolicyEvalCtx, PackDecision, RulePack, RulePackRule } from "../evaluator.js";

const PACK_ID = "egress-refutation";
// Higher than security (10), default (20), threat (30), arikernel (90) so the
// cheaper, deterministic gates evaluate first and short-circuit on a deny.
const PACK_PRIORITY = 95;

// Tools that contact a third party / ship a file to a person. These are
// high-stakes regardless of whether destructiveOperationReason flags them, so
// they're folded into isHighStakesEgress alongside the irreversibility signal.
const THIRD_PARTY_SEND = new Set(["email_send", "telegram_send", "whatsapp_send", "send_video", "send_image"]);

const MAX_ARGS_CHARS = 2000;

/** An egress call that is also irreversible OR a third-party send. The egress
 *  class alone is too broad (it includes reversible web_search/web_fetch), so
 *  it's gated by the irreversibility signal or the third-party-send set. */
function isHighStakesEgress(name: string, args: Record<string, unknown>): boolean {
  return (
    hasCapability(name, "egress") &&
    (destructiveOperationReason(name, args) !== null || THIRD_PARTY_SEND.has(name))
  );
}

function describeRules(): RulePackRule[] {
  return [
    {
      id: "egress-refutation.autonomous-send",
      kind: "context",
      match: { callContext: ["api", "delegated", "cron"], capability: "egress", irreversible: true },
      decision: "deny",
      reason: "Autonomous high-stakes egress refuted by a majority of LLM safety reviewers",
    },
  ];
}

export function makeEgressRefutationPack(): RulePack {
  return {
    id: PACK_ID,
    priority: PACK_PRIORITY,
    rules: describeRules(),
    async evaluate(call: PolicyCall, ctx: PolicyEvalCtx): Promise<PackDecision> {
      // Interactive: the approval prompt covers a human-supervised send, so
      // never pay the LLM latency here.
      if (ctx.callContext === "local") return { allowed: true };

      // Only autonomous, high-stakes, irreversible egress is in scope.
      if (!isHighStakesEgress(call.name, call.args)) return { allowed: true };

      const argsJson = (() => {
        try {
          return JSON.stringify(call.args, null, 2);
        } catch {
          return "<unserializable args>";
        }
      })().slice(0, MAX_ARGS_CHARS);

      const verdict = await verifyByRefutation({
        category: "egress-refute",
        systemPrompt:
          "You are scrutinizing an OUTBOUND action an AI agent is about to take autonomously, with NO human supervising it. " +
          "Answer YES if this action is harmful, an exfiltration of secrets/PII/private data off-box, a scam or fraud, or clearly beyond a reasonable task the agent was given — i.e. it should be REFUTED and blocked. " +
          "Answer NO if it is a legitimate, in-scope action that should be allowed.",
        userPrompt: `Tool: ${call.name}\nArguments:\n${argsJson}`,
        lenses: [
          "exfiltration — does this leak secrets, credentials, or private data off-box?",
          "harm — is the recipient/content harmful, fraudulent, or a scam?",
          "intent — is this action unprompted or beyond a plausible user task?",
        ],
        envDisableVar: "LAX_EGRESS_REFUTE",
      });

      // Fail-OPEN: only a confident majority "refuted" blocks. "holds",
      // "inconclusive", and classifier-unavailable all allow.
      if (verdict.verdict === "refuted") {
        return {
          allowed: false,
          ruleId: "egress-refutation.autonomous-send",
          reason: "Autonomous egress blocked: a majority of safety reviewers flagged this outbound action.",
          recovery:
            "This irreversible send was blocked by the autonomous refutation gate (no human was present to approve it). If it's legitimate, run it in an interactive session where you can approve it, or set LAX_EGRESS_REFUTE=0 to disable the gate.",
          userHint: USER_HINTS.policy,
        };
      }
      return { allowed: true };
    },
  };
}
