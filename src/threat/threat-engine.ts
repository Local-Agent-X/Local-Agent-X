/**
 * THREAT ENGINE — Advanced behavioral security for Local Agent X
 *
 * Five integrated behavioral security systems, each in its own module
 * under src/threat/:
 *
 * 1. tool-chain.ts        — Tracks sequences of tool calls and blocks
 *                           exfiltration patterns + loop patterns.
 * 2. canaries.ts          — Hidden phrases in system prompt; if any
 *                           appear in agent output, prompt injection
 *                           detected — kill the response.
 * 3. classification.ts    — Tags tool results as containing credentials,
 *                           PII, code, etc. so subsequent tools can be
 *                           restricted accordingly.
 * 4. scoring.ts           — Real-time session risk score; suspicious
 *                           patterns raise the score; high score =
 *                           restricted mode.
 * 5. audit-trail.ts       — Hash-chained log of all security decisions.
 *                           Tamper-evident — modifying the log breaks
 *                           the chain.
 *
 * This file wires them together as `ThreatEngine` (the per-session
 * orchestrator) and re-exports the public types plus `SessionThreatManager`
 * (the multi-session score map, which lives in session-threat-manager.ts).
 */

import { canaryPromptBlock, checkCanaries, generateCanaries, registerSessionCanaries } from "./canaries.js";
import { classifyData, type DataLabel } from "./classification.js";
import { CryptoAuditTrail, getSharedAuditTrail } from "./audit-trail.js";
import { THREAT_SCORES, ThreatScorer, type ThreatLevel } from "./scoring.js";
import { readThreatScorerOptions } from "./scorer-options.js";
import { ToolChainAnalyzer } from "./tool-chain.js";

export { _invalidateThreatSettingsCacheForTests } from "./scorer-options.js";

export { classifyData, type DataClassification, type DataLabel } from "./classification.js";
export { generateCanaries, canaryPromptBlock, checkCanaries, checkCanariesInPayload, getSessionCanaries, registerSessionCanaries, clearSessionCanaries } from "./canaries.js";
export { ThreatScorer, THREAT_SCORES, type ThreatLevel } from "./scoring.js";
export { ToolChainAnalyzer } from "./tool-chain.js";
export { CryptoAuditTrail } from "./audit-trail.js";
export { SessionThreatManager } from "./session-threat-manager.js";

// ═══════════════════════════════════════════════════════════════════
// UNIFIED THREAT ENGINE — per-session orchestrator
// ═══════════════════════════════════════════════════════════════════

export class ThreatEngine {
  readonly chain: ToolChainAnalyzer;
  readonly scorer: ThreatScorer;
  readonly audit: CryptoAuditTrail;
  private canaries: string[];
  private sessionId: string;

  /** Mark the next `durationMs` window as user-consented. Chat entrypoint
   *  calls this when the user message has attachments + directive language
   *  ("enter this in X", "submit to X"). Exfil patterns during the window
   *  are audited but not blocked. See ToolChainAnalyzer.markUserConsent. */
  markUserConsentFlow(durationMs: number, reason: string): void {
    this.chain.markUserConsent(durationMs, reason);
    this.audit.record({
      sessionId: this.sessionId,
      event: "user_consent_flow_started",
      toolName: "(none)",
      decision: "allow",
      reason,
      threatScore: this.scorer.getStatus().score,
      threatLevel: this.scorer.getStatus().level,
    });
  }

  constructor(dataDir: string, sessionId: string = "default") {
    this.chain = new ToolChainAnalyzer();
    this.scorer = new ThreatScorer(readThreatScorerOptions());
    // Shared single-writer audit trail (finding H10): every per-turn ThreatEngine
    // (and the read-only "audit-read" engine) targets the same daily file, so
    // they must share ONE instance or their independent chain heads collide and
    // break verify() during normal operation.
    this.audit = getSharedAuditTrail(dataDir);
    this.canaries = generateCanaries();
    this.sessionId = sessionId;
    // Publish this session's canaries to the shared registry so the egress
    // seam can check outbound payloads against the SAME tokens embedded in the
    // model's system prompt (these are also what checkOutput watches for).
    registerSessionCanaries(this.sessionId, this.canaries);
  }

  /** Get canary tokens for system prompt injection */
  getCanaryBlock(): string {
    return canaryPromptBlock(this.canaries);
  }

  /**
   * Full security evaluation AFTER a tool executes.
   * Called with the tool result to check for exfiltration, canaries, data leaks.
   */
  evaluateToolResult(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    allowed: boolean
  ): {
    blocked: boolean;
    reason?: string;
    threatLevel: ThreatLevel;
    threatScore: number;
    dataLabels: DataLabel[];
  } {
    // Classify the data in the result
    const classification = classifyData(result);

    // Snapshot the restriction state BEFORE this call scores anything. A tool
    // blocked *because the session is already restricted* is a symptom, not new
    // evidence: re-scoring it climbs the load and resets the decay clock, so the
    // restriction reinforces itself and never lifts in-session (live failure
    // 2026-06-23 — a flail spent its whole turn budget re-tripping its own
    // restriction). While restricted we still ENFORCE every block and AUDIT it;
    // we just stop scoring it so accrued time/turn decay credit can drain the
    // load and recover.
    const alreadyRestricted = this.scorer.isRestricted();

    // Chain analysis (exfiltration + loop detection)
    const chainResult = this.chain.recordAndAnalyze(toolName, args, classification);

    // Record threat events
    if (!allowed) {
      if (!alreadyRestricted) {
        this.scorer.record("security_block", THREAT_SCORES.security_block, `${toolName} blocked`);
      }
      this.audit.record({
        sessionId: this.sessionId,
        event: "tool_blocked",
        toolName,
        decision: "block",
        reason: "Security layer blocked",
        threatScore: this.scorer.getStatus().score,
        threatLevel: this.scorer.getStatus().level,
      });
    }

    // Temporal staging signal (a sensitive read preceded this external call but
    // nothing secret was on the wire). Not a block — a behavioral score so a
    // persistent read-then-send pattern still escalates the session. Suppressed
    // when the user consented to the flow, and while already restricted (same
    // recovery rationale as blocks above).
    if (chainResult.staging && !chainResult.allowedByConsent && !alreadyRestricted) {
      this.scorer.record("exfiltration_staging", THREAT_SCORES.exfiltration_staging, chainResult.staging.description);
      this.audit.record({
        sessionId: this.sessionId,
        event: "exfiltration_staging_signal",
        toolName,
        decision: "allow",
        reason: chainResult.staging.description,
        threatScore: this.scorer.getStatus().score,
        threatLevel: this.scorer.getStatus().level,
      });
    }

    // An exfil pattern fired but was let through by user-consent. Audit
    // it as an "allowed exfiltration" event so the security record is
    // preserved — we ALLOWED it because the user consented, not because
    // the threat didn't exist.
    if (chainResult.allowedByConsent && (chainResult.exfil || chainResult.staging)) {
      this.audit.record({
        sessionId: this.sessionId,
        event: "exfiltration_allowed_by_consent",
        toolName,
        decision: "allow",
        reason: `${(chainResult.exfil ?? chainResult.staging)!.description} — allowed by ${chainResult.allowedByConsent}`,
        threatScore: this.scorer.getStatus().score,
        threatLevel: this.scorer.getStatus().level,
      });
    }

    if (chainResult.blocked) {
      if (!alreadyRestricted) {
        const score = chainResult.exfil ? THREAT_SCORES.exfiltration_pattern : THREAT_SCORES.loop_detected;
        this.scorer.record(chainResult.exfil ? "exfiltration" : "loop", score, chainResult.reason!);
      }
      this.audit.record({
        sessionId: this.sessionId,
        event: chainResult.exfil ? "exfiltration_detected" : "loop_detected",
        toolName,
        decision: "block",
        reason: chainResult.reason!,
        threatScore: this.scorer.getStatus().score,
        threatLevel: this.scorer.getStatus().level,
      });
      // Layer C: stash the fingerprint on the session so /approve can find
      // it and record into the trust ledger. Lazy-imported to keep the
      // threat-engine module's import surface lean.
      if (chainResult.blockedFingerprint) {
        void import("./consent-store.js").then(({ recordLastBlockedFingerprint }) => {
          recordLastBlockedFingerprint(this.sessionId, chainResult.blockedFingerprint!);
        }).catch(() => {});
      }
      const status = this.scorer.getStatus();
      return {
        blocked: true,
        reason: chainResult.reason,
        threatLevel: status.level,
        threatScore: status.score,
        dataLabels: classification.labels,
      };
    }

    // Score based on classification
    if (classification.labels.includes("credentials")) {
      this.scorer.record("credential_in_output", THREAT_SCORES.credential_in_output, `Credentials detected in ${toolName} result`);
    }
    if (classification.labels.includes("secrets")) {
      this.scorer.record("secrets_in_output", THREAT_SCORES.sensitive_data_external, `Secrets detected in ${toolName} result`);
    }

    // Successful tool execution that produced no new threat event → trust
    // regenerates. Drives the per-turn side of the decay-credit model so
    // sessions that keep behaving don't carry old suspicion indefinitely.
    const credentialFlag = classification.labels.includes("credentials") || classification.labels.includes("secrets");
    if (allowed && !credentialFlag) {
      this.scorer.recordSuccessfulTurn();
    }

    // Audit the call
    this.audit.record({
      sessionId: this.sessionId,
      event: "tool_executed",
      toolName,
      decision: "allow",
      reason: "Executed successfully",
      threatScore: this.scorer.getStatus().score,
      threatLevel: this.scorer.getStatus().level,
      dataLabels: classification.labels.length > 0 ? classification.labels : undefined,
    });

    const finalStatus = this.scorer.getStatus();
    return {
      blocked: false,
      threatLevel: finalStatus.level,
      threatScore: finalStatus.score,
      dataLabels: classification.labels,
    };
  }

  /**
   * Check agent output for canary tokens.
   * Call this on every LLM text chunk before sending to user.
   */
  checkOutput(text: string): string | null {
    const canaryResult = checkCanaries(text, this.canaries);
    if (canaryResult) {
      this.scorer.record("canary_tripped", THREAT_SCORES.canary_tripped, canaryResult);
      this.audit.record({
        sessionId: this.sessionId,
        event: "canary_tripped",
        decision: "block",
        reason: canaryResult,
        threatScore: this.scorer.getStatus().score,
        threatLevel: this.scorer.getStatus().level,
      });
    }
    return canaryResult;
  }

  /** Is the session currently in restricted mode? */
  isRestricted(): boolean {
    return this.scorer.isRestricted();
  }

  /** Reset for new session */
  reset(newSessionId?: string): void {
    this.chain.reset();
    this.scorer.reset();
    this.canaries = generateCanaries();
    if (newSessionId) this.sessionId = newSessionId;
    registerSessionCanaries(this.sessionId, this.canaries);
  }

  // ── Canary token rotation ──

  private canaryRotationTimer: ReturnType<typeof setInterval> | null = null;
  private canaryRotationIntervalMs = 24 * 60 * 60 * 1000; // 24 hours

  /** Auto-rotate canary strings on a schedule (default: every 24h) */
  autoRotateCanary(intervalMs?: number): void {
    if (this.canaryRotationTimer) clearInterval(this.canaryRotationTimer);
    if (intervalMs) this.canaryRotationIntervalMs = intervalMs;
    this.canaryRotationTimer = setInterval(() => {
      this.canaries = generateCanaries();
      registerSessionCanaries(this.sessionId, this.canaries);
      this.audit.record({
        sessionId: this.sessionId,
        event: "canary_rotated",
        decision: "allow",
        reason: "Canary tokens rotated on schedule",
        threatScore: this.scorer.getStatus().score,
        threatLevel: this.scorer.getStatus().level,
      });
    }, this.canaryRotationIntervalMs);
  }

  /** Stop canary auto-rotation */
  stopCanaryRotation(): void {
    if (this.canaryRotationTimer) {
      clearInterval(this.canaryRotationTimer);
      this.canaryRotationTimer = null;
    }
  }

  /** Force immediate canary rotation */
  rotateCanariesNow(): string[] {
    this.canaries = generateCanaries();
    registerSessionCanaries(this.sessionId, this.canaries);
    return this.canaries;
  }

  // ── ARI explainability ──

  /** Last block reason for explainability */
  private lastBlockDetails: {
    event: string;
    toolName?: string;
    reason: string;
    controls: string[];
    timestamp: number;
  } | null = null;

  /** Record a block event for explainability */
  recordBlockExplanation(event: string, reason: string, controls: string[], toolName?: string): void {
    this.lastBlockDetails = { event, toolName, reason, controls, timestamp: Date.now() };
  }

  /** Get plain English explanation for the most recent block */
  getExplanation(): string | null {
    if (!this.lastBlockDetails) return null;
    const d = this.lastBlockDetails;
    const controlList = d.controls.length > 0 ? d.controls.join(", ") : "general policy";
    const toolPart = d.toolName ? ` on tool "${d.toolName}"` : "";
    return `Block${toolPart}: ${d.reason} (detected by: ${controlList}). ` +
      `This action was blocked because it matched a known threat pattern. ` +
      `Current threat level: ${this.scorer.getStatus().level} (score: ${this.scorer.getStatus().score}).`;
  }
}
