/**
 * Threat-engine pack — pre-tool-call checks only. Extracts the
 * RESTRICTED_EXTERNAL_TOOLS gate that was previously inlined in
 * pre-dispatch.ts. Post-tool-call analysis (recordAndAnalyze + trust-ledger
 * learning) stays in src/threat/tool-chain.ts — that's a separate concern,
 * not a rule.
 */
import type { ThreatEngine } from "../../threat-engine.js";
import type { PolicyCall, PolicyEvalCtx, PackDecision, RulePack, RulePackRule } from "../evaluator.js";

const PACK_ID = "threat-engine";
const PACK_PRIORITY = 30;

const RESTRICTED_EXTERNAL_TOOLS = new Set(["http_request", "web_fetch", "browser"]);

function isOwnAppBrowserCall(args: Record<string, unknown>): boolean {
  const urlArg = String(args.url || "");
  const appPort = process.env.LAX_PORT ?? process.env.SAX_PORT ?? "7007";
  return new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${appPort}`, "i").test(urlArg);
}

function describeRules(): RulePackRule[] {
  return Array.from(RESTRICTED_EXTERNAL_TOOLS).map((tool) => ({
    id: `threat.restricted.${tool}`,
    kind: "threat",
    match: { tool, when: "session-restricted" },
    decision: "deny",
    reason: "Session threat level elevated. External tool calls restricted.",
  }));
}

export function makeThreatEnginePack(threatEngine: ThreatEngine | undefined): RulePack {
  return {
    id: PACK_ID,
    priority: PACK_PRIORITY,
    rules: describeRules(),
    evaluate(call: PolicyCall, _ctx: PolicyEvalCtx): PackDecision {
      if (!threatEngine) return { allowed: true };
      if (!threatEngine.isRestricted()) return { allowed: true };
      if (!RESTRICTED_EXTERNAL_TOOLS.has(call.name)) return { allowed: true };
      if (call.name === "browser" && isOwnAppBrowserCall(call.args)) return { allowed: true };
      return {
        allowed: false,
        ruleId: `threat.restricted.${call.name}`,
        reason: "Session threat level elevated. External tool calls restricted.",
      };
    },
  };
}
