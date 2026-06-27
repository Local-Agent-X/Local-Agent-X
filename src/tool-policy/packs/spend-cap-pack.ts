/**
 * Spend-cap pack — opt-in USD budget gate. When the configured daily or
 * per-session spend cap is reached, every further tool call is denied with a
 * clear recovery message so the agent stops burning money and tells the user.
 *
 * Disabled by default: with both budgets at 0/undefined this pack always
 * allows, so it's a no-op until the user sets a cap in Settings. Runs early
 * (low priority number) so a tripped budget short-circuits before any other
 * policy work.
 */
import { getRuntimeConfig } from "../../config.js";
import { getTodayCost, getSessionCost } from "../../cost-tracker.js";
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

      if (dailyBudgetUsd > 0) {
        const spent = getTodayCost().costUsd;
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
        const spent = getSessionCost(ctx.sessionId).costUsd;
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
