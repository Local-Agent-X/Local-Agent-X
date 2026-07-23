/**
 * Threat-engine pack — pre-tool-call checks only. Extracts the
 * RESTRICTED_EXTERNAL_TOOLS gate that was previously inlined in
 * pre-dispatch.ts. Post-tool-call analysis (recordAndAnalyze + trust-ledger
 * learning) stays in src/threat/tool-chain.ts — that's a separate concern,
 * not a rule.
 *
 * Restriction semantics (2026-07-23 rework):
 *   - Restriction itself is evidence-gated in ThreatScorer.isRestricted().
 *   - When the evidence names external sinks (exfiltration has a target URL),
 *     only calls targeting those registrable domains are denied — the rest of
 *     the internet stays reachable.
 *   - When the evidence has no attributable sink (canary trip, credentials in
 *     output), all external calls are denied as before — we don't know where
 *     a leak would go.
 *   - The deny message states the actual evidence and recovery path. It must
 *     NEVER read as a network failure — the old "I can't reach that URL" hint
 *     sent a live session into a connectivity-debugging flail (2026-07-23).
 */
import { externalSinkDomain, type ThreatEngine } from "../../threat/threat-engine.js";
import { USER_HINTS } from "../../types.js";
import type { PolicyCall, PolicyEvalCtx, PackDecision, RulePack, RulePackRule } from "../evaluator.js";

const PACK_ID = "threat-engine";
const PACK_PRIORITY = 30;

const RESTRICTED_EXTERNAL_TOOLS = new Set(["http_request", "web_fetch", "browser"]);

const RULE_REASON =
  "Session security restriction active (deterministic evidence recorded). External calls to implicated sinks denied; all external calls denied when the evidence has no attributable sink.";

function isOwnAppBrowserCall(args: Record<string, unknown>): boolean {
  const urlArg = String(args.url || "");
  const appPort = process.env.LAX_PORT ?? "7007";
  return new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${appPort}`, "i").test(urlArg);
}

function describeRules(): RulePackRule[] {
  return Array.from(RESTRICTED_EXTERNAL_TOOLS).map((tool) => ({
    id: `threat.restricted.${tool}`,
    kind: "threat",
    match: { tool, when: "session-restricted" },
    decision: "deny",
    reason: RULE_REASON,
  }));
}

/** The truthful deny reason: names the evidence, denies the network-failure
 *  reading explicitly, and states both recovery paths. This is the ONE source
 *  of truth for the restriction message — both the pre-dispatch pack (below) and
 *  the flip-turn post-execution deny (audit-tool-call.ts) render from here so the
 *  two paths can never drift. */
export function buildDenyReason(evidence: { types: string[]; sinks: string[] }): string {
  const types = evidence.types.length > 0 ? evidence.types.join(", ") : "confirmed breach";
  const sinkPart = evidence.sinks.length > 0
    ? ` implicating external sink(s): ${evidence.sinks.join(", ")};`
    : "";
  return (
    `Security restriction: this session recorded ${types} evidence;${sinkPart} ` +
    `external calls are blocked by the threat engine. This is NOT a network failure — the destination was never contacted. ` +
    `Recovery: the user can run /approve <reason> to consent, or the restriction decays on its own with quiet turns/time.`
  );
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

      const evidence = threatEngine.getRestrictionEvidence();

      // Sink-scoped restriction: evidence named its destination(s), so only
      // calls targeting an implicated registrable domain are denied.
      if (evidence.sinks.length > 0) {
        const urlArg = call.args.url;
        const hasUrl = typeof urlArg === "string" && urlArg.length > 0;
        if (!hasUrl && call.name === "browser") {
          // Non-navigation browser action (snapshot/click/…) operating on the
          // CURRENT page. This pack cannot see the current page URL — but
          // navigation TO an implicated sink is denied above, so the current
          // page cannot have been reached through this gate. Allow.
          return { allowed: true };
        }
        // Same domain derivation as the engine's sink recording — must not drift.
        const targetDomain = hasUrl ? externalSinkDomain(String(urlArg)) : null;
        if (targetDomain !== null && !evidence.sinks.includes(targetDomain)) {
          return { allowed: true };
        }
        // Implicated domain, or an unresolvable target on a URL-carrying
        // call (http_request/web_fetch always carry one) → deny below.
      }
      // Empty sink set: pure canary/credential evidence with no attributable
      // destination → conservative deny of all external calls.

      return {
        allowed: false,
        ruleId: `threat.restricted.${call.name}`,
        reason: buildDenyReason(evidence),
        userHint: USER_HINTS.threatRestricted,
      };
    },
  };
}
