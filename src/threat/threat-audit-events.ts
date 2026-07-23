// Pre-score audit-event emission for ThreatEngine.evaluateToolResult. These
// three emissions run BEFORE the scorer records anything and have no other side
// effects, so they factor out cleanly — extracted from threat-engine.ts to keep
// that per-session orchestrator under the source-hygiene LOC ceiling. Behavior
// is byte-for-byte identical to the inlined form.

import type { CryptoAuditTrail } from "./audit-trail.js";
import type { ThreatScorer } from "./scoring.js";

/** The subset of a ToolChainAnalyzer.recordAndAnalyze result these audits read. */
interface ChainAuditOutcome {
  staging?: { description: string };
  exfil?: { description: string };
  allowedByConsent?: string;
}

/**
 * Emit the pre-score audit events for a tool-chain outcome:
 *   1. A tool blocked by ANOTHER security layer is audited but never scored. The
 *      scorer accumulates risk only from deterministic evidence this engine
 *      observes directly (secret-carrying payloads, tripped canaries,
 *      credentials/secrets in output); feeding other layers' block decisions back
 *      into the scorer made any false positive elsewhere an amplifier loop that
 *      accelerated threat restriction.
 *   2. Temporal staging signal (a sensitive read preceded this external call but
 *      nothing secret was on the wire). Observability ONLY: audited but never
 *      scored. Temporal correlation is a heuristic, not evidence — 19 staging
 *      fires over 7 weeks produced 0 true positives, and because memory reads are
 *      always classified sensitive, scoring it turned ordinary memory_search →
 *      browser work into accumulating risk that restricted a live session
 *      mid-task (2026-07-23). The audit is suppressed when the user consented to
 *      the flow (recorded as exfiltration_allowed_by_consent instead) and while
 *      already restricted.
 *   3. An exfil pattern fired but was let through by user-consent. Audited as an
 *      "allowed exfiltration" so the security record is preserved — we ALLOWED it
 *      because the user consented, not because the threat didn't exist.
 */
export function emitPreScoreChainAudit(
  audit: CryptoAuditTrail,
  scorer: ThreatScorer,
  sessionId: string,
  toolName: string,
  allowed: boolean,
  alreadyRestricted: boolean,
  chain: ChainAuditOutcome,
): void {
  if (!allowed) {
    audit.record({
      sessionId,
      event: "tool_blocked",
      toolName,
      decision: "block",
      reason: "Security layer blocked",
      threatScore: scorer.getStatus().score,
      threatLevel: scorer.getStatus().level,
    });
  }

  if (chain.staging && !chain.allowedByConsent && !alreadyRestricted) {
    audit.record({
      sessionId,
      event: "exfiltration_staging_signal",
      toolName,
      decision: "allow",
      reason: chain.staging.description,
      threatScore: scorer.getStatus().score,
      threatLevel: scorer.getStatus().level,
    });
  }

  if (chain.allowedByConsent && (chain.exfil || chain.staging)) {
    audit.record({
      sessionId,
      event: "exfiltration_allowed_by_consent",
      toolName,
      decision: "allow",
      reason: `${(chain.exfil ?? chain.staging)!.description} — allowed by ${chain.allowedByConsent}`,
      threatScore: scorer.getStatus().score,
      threatLevel: scorer.getStatus().level,
    });
  }
}
