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
 * orchestrator) and re-exports the public types.
 */

import { canaryPromptBlock, checkCanaries, generateCanaries, registerSessionCanaries } from "./canaries.js";
import { classifyData, type DataLabel } from "./classification.js";
import { CryptoAuditTrail, getSharedAuditTrail } from "./audit-trail.js";
import { THREAT_SCORES, ThreatScorer, type ThreatLevel, type ThreatScorerState } from "./scoring.js";
import { readThreatScorerOptions } from "./scorer-options.js";
import { ToolChainAnalyzer, type ToolChainState } from "./tool-chain.js";
import { restoreLastBlockedFingerprint } from "./consent-store.js";

export interface ThreatEngineState {
  scorer: ThreatScorerState;
  chain: ToolChainState;
  canaries: string[];
}

export { _invalidateThreatSettingsCacheForTests } from "./scorer-options.js";

export { classifyData, type DataClassification, type DataLabel } from "./classification.js";
export { generateCanaries, canaryPromptBlock, checkCanaries, checkCanariesInPayload, getSessionCanaries, registerSessionCanaries, clearSessionCanaries } from "./canaries.js";
export { ThreatScorer, THREAT_SCORES, type ThreatLevel } from "./scoring.js";
export { ToolChainAnalyzer } from "./tool-chain.js";
export { CryptoAuditTrail } from "./audit-trail.js";

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

  snapshot(): ThreatEngineState {
    return {
      scorer: this.scorer.snapshot(),
      chain: this.chain.snapshot(),
      canaries: [...this.canaries],
    };
  }

  restore(state: ThreatEngineState): void {
    if (!Array.isArray(state.canaries) || state.canaries.length === 0
      || state.canaries.some(canary => typeof canary !== "string" || canary.length < 8)) {
      throw new Error("invalid persisted threat canary state");
    }
    this.scorer.restore(state.scorer);
    this.chain.restore(state.chain);
    this.canaries = [...state.canaries];
    registerSessionCanaries(this.sessionId, this.canaries);
    if (state.chain.lastBlockedFingerprint && state.chain.lastBlockedAt !== null) {
      restoreLastBlockedFingerprint(this.sessionId, state.chain.lastBlockedFingerprint, state.chain.lastBlockedAt);
    }
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
    /** The block is a runaway-loop circuit-break, not a security/consent event.
     *  The renderer uses this to give a recoverable "change approach" message
     *  instead of the /approve consent template. */
    loop?: boolean;
    threatLevel: ThreatLevel;
    threatScore: number;
    dataLabels: DataLabel[];
  } {
    // Classify the data in the result
    const classification = classifyData(result);

    // Snapshot the restriction state BEFORE this call scores anything. While
    // restricted we still ENFORCE and AUDIT everything, but even genuine
    // evidence events are not re-scored: every scorer.record() resets the
    // decay clock, so re-scoring symptoms of the restriction itself would keep
    // it from ever lifting in-session (live failure 2026-06-23 — a flail spent
    // its whole turn budget re-tripping its own restriction).
    const alreadyRestricted = this.scorer.isRestricted();

    // Chain analysis (exfiltration + loop detection)
    const chainResult = this.chain.recordAndAnalyze(toolName, args, classification);

    // A tool blocked by ANOTHER security layer is audited but never scored.
    // The scorer accumulates risk only from deterministic evidence this engine
    // observes directly (secret-carrying payloads, tripped canaries,
    // credentials/secrets in output); feeding other layers' block decisions
    // back into the scorer made any false positive elsewhere an amplifier
    // loop that accelerated threat restriction.
    if (!allowed) {
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
    // nothing secret was on the wire). Observability ONLY: audited but never
    // scored. Temporal correlation is a heuristic, not evidence — 19 staging
    // fires over 7 weeks produced 0 true positives, and because memory reads
    // are always classified sensitive, scoring it turned ordinary
    // memory_search → browser work into accumulating risk that restricted a
    // live session mid-task (2026-07-23). Payload-based exfiltration evidence
    // still blocks and scores above/below. The audit is suppressed when the
    // user consented to the flow (recorded as exfiltration_allowed_by_consent
    // instead) and while already restricted.
    if (chainResult.staging && !chainResult.allowedByConsent && !alreadyRestricted) {
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
      // A runaway loop is a circuit-breaker concern, not a security threat. The
      // block itself already halts the loop; scoring it into the SECURITY scorer
      // would push a benign read-only loop (e.g. grep↔read making no progress)
      // toward network-restricted mode — the EXFILTRATION response — and the
      // /approve consent path the renderer attaches to a security block is a dead
      // end for a model that's merely stuck. So a loop is audited (below) but
      // never scored or escalated. Exfil and encoding-prep blocks are genuine
      // security events and keep their existing score.
      if (!alreadyRestricted && !chainResult.loopDetected) {
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
        loop: !!chainResult.loopDetected,
        threatLevel: status.level,
        threatScore: status.score,
        dataLabels: classification.labels,
      };
    }

    // Score based on classification. Suppressed while already restricted (same
    // recovery rationale as the blocks/staging above): every scorer.record()
    // resets the decay clock (lastEventAt + successfulTurnsSinceLastEvent), so a
    // restricted session that reads its own secret files (e.g. ~/.lax/config.json
    // during recovery) would perpetually wipe the time+turn credit it needs to
    // lift the restriction. We still ENFORCE and (below) AUDIT the read.
    if (!alreadyRestricted && classification.labels.includes("credentials")) {
      this.scorer.record("credential_in_output", THREAT_SCORES.credential_in_output, `Credentials detected in ${toolName} result`);
    }
    if (!alreadyRestricted && classification.labels.includes("secrets")) {
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
}
