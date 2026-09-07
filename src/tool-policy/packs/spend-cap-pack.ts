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
 * ON by default (config-schema.ts: $15/session, $75/day); a user who sets both
 * budgets to 0 opts out and this pack always allows. Runs early (low priority
 * number) so a tripped budget short-circuits before any other policy work.
 *
 * Sibling enforcement point: canonical-loop/checkpoint-stop.ts ends an op at
 * its next iteration checkpoint on the same budgets. That predicate judges
 * the op's OWN credential (op.contextPack.routing.authSource); this pack
 * cannot — see the note at the oauth short-circuit below.
 */
import { getRuntimeConfig } from "../../config.js";
import { getTodayBillableCost, getSessionBillableCost, getResolvedAuthSource, getResolvedModel, getBillableCostForModelSince } from "../../cost-tracker.js";
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
      const modelBudgets = cfg.modelDailyBudgetsUsd ?? {};
      const hasModelBudget = Object.values(modelBudgets).some(v => (v ?? 0) > 0);

      // Every cap explicitly disabled (0) — nothing to enforce.
      if (!dailyBudgetUsd && !sessionBudgetUsd && !hasModelBudget) return { allowed: true };

      // Flat-rate subscription (Claude CLI / SuperGrok / ChatGPT): per-call USD
      // is fiction — the user pays a fixed monthly fee, not per token. A USD cap
      // must never block them. Runaway loops are still bounded by the
      // checkpoint predicate's dry-checkpoint stop and the wall-clock deadline.
      //
      // KNOWN LIMITATION — process-global, not per-op. PolicyEvalCtx carries
      // only {sessionId, callContext}; it does not identify the op whose tool
      // call this is, and one session can host ops on different credentials
      // (a chat turn on a subscription, a spawned sub-agent on an API key), so
      // sessionId cannot be mapped to a single authSource without widening
      // PolicyEvalCtx — a type owned by tool-policy/evaluator.ts, outside this
      // change. Until it carries the op's authSource, this reads the LAST
      // credential any model call in the process resolved. The ledger reads
      // below are per-record (isBillableSource), so subscription spend is
      // never billed regardless; the exposure is only in WHICH op this early
      // return exempts when two credentials are in flight at once.
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

      // Per-model daily cap. Reached only on API-key billing (the oauth
      // short-circuit above already returned for subscription), against the
      // model actually in use this turn.
      const model = getResolvedModel();
      const modelCap = model ? (modelBudgets[model] ?? 0) : 0;
      if (model && modelCap > 0) {
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
        const spent = getBillableCostForModelSince(model, startOfDay.getTime());
        if (spent >= modelCap) {
          return {
            allowed: false,
            ruleId: "spend-cap.model",
            reason: `Today's ${model} spend ($${spent.toFixed(2)}) has reached its daily cap ($${modelCap.toFixed(2)}).`,
            recovery:
              `The daily limit for ${model} is spent. Tell the user; switch to a different model, or raise this model's limit in Settings → Usage. Do not retry on ${model} — this will deny again.`,
            userHint: USER_HINTS.policy,
          };
        }
      }

      return { allowed: true };
    },
  };
}
