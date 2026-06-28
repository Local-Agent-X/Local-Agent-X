/**
 * Spend-cap pack — opt-in USD budget gate on REAL per-call API spend. When the
 * configured daily or per-session cap is reached, every further tool call is
 * denied with a clear recovery message so the agent stops burning money and
 * tells the user.
 *
 * Auth-aware: a flat-rate subscription (oauth — Claude CLI / SuperGrok /
 * ChatGPT) has no per-call USD cost, so the cap never applies to it (the
 * token×price figure is a shadow estimate, not money). The cap bills only
 * usage on a real per-token API key — see cost-tracker `isBillableSource`.
 *
 * Disabled by default: with both budgets at 0/undefined this pack always
 * allows, so it's a no-op until the user sets a cap in Settings. Runs early
 * (low priority number) so a tripped budget short-circuits before any other
 * policy work.
 */
import { getRuntimeConfig } from "../../config.js";
import { getTodayBillableCost, getSessionBillableCost, getResolvedAuthSource } from "../../cost-tracker.js";
import { USER_HINTS } from "../../types.js";
import type { PolicyCall, PolicyEvalCtx, PackDecision, RulePack, RulePackRule } from "../evaluator.js";

const PACK_ID = "spend-cap";
const PACK_PRIORITY = 5;

function describeRules(): RulePackRule[] {
  return [
    {
      id: "spend-cap.daily",
      kind: "rate-limit",
      match: { setting: "dailyBudgetUsd" },
      decision: "deny",
      reason: "Daily spend has reached the configured budget",
    },
    {
      id: "spend-cap.session",
      kind: "rate-limit",
      match: { setting: "sessionBudgetUsd" },
      decision: "deny",
      reason: "Session spend has reached the configured budget",
    },
  ];
}

export function makeSpendCapPack(): RulePack {
  return {
    id: PACK_ID,
    priority: PACK_PRIORITY,
    rules: describeRules(),
    evaluate(_call: PolicyCall, ctx: PolicyEvalCtx): PackDecision {
      // Read live so a setting change applies mid-session.
      const cfg = getRuntimeConfig();
      const dailyBudgetUsd = cfg.dailyBudgetUsd ?? 0;
      const sessionBudgetUsd = cfg.sessionBudgetUsd ?? 0;

      // Disabled by default — no caps configured.
      if (!dailyBudgetUsd && !sessionBudgetUsd) return { allowed: true };

      // Flat-rate subscription (Claude CLI / SuperGrok / ChatGPT): per-call USD
      // is fiction — the user pays a fixed monthly fee, not per token. A USD cap
      // must never block them. Runaway loops are still bounded by the universal
      // iteration + wall-clock guards on the op budget.
      if (getResolvedAuthSource() === "oauth") return { allowed: true };

      // Bill only real-money (per-call API key) usage; subscription/local spend
      // is shadow cost and excluded by getXBillableCost.
      if (dailyBudgetUsd > 0) {
        const spent = getTodayBillableCost().costUsd;
        if (spent >= dailyBudgetUsd) {
          return {
            allowed: false,
            ruleId: "spend-cap.daily",
            reason: `Daily spend ($${spent.toFixed(2)}) has reached the configured budget ($${dailyBudgetUsd.toFixed(2)}).`,
            recovery:
              "The daily budget is spent. Tell the user and stop calling tools; raise the budget in Settings or wait until tomorrow. Do not retry — this will deny again.",
            userHint: USER_HINTS.policy,
          };
        }
      }

      if (sessionBudgetUsd > 0) {
        const spent = getSessionBillableCost(ctx.sessionId).costUsd;
        if (spent >= sessionBudgetUsd) {
          return {
            allowed: false,
            ruleId: "spend-cap.session",
            reason: `Session spend ($${spent.toFixed(2)}) has reached the configured budget ($${sessionBudgetUsd.toFixed(2)}).`,
            recovery:
              "The session budget is spent. Tell the user and stop calling tools; raise the budget in Settings or start a new session. Do not retry — this will deny again.",
            userHint: USER_HINTS.policy,
          };
        }
      }

      return { allowed: true };
    },
  };
}
