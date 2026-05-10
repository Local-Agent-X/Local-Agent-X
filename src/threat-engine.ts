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
 * This file wires them together as `ThreatEngine` (per-session
 * orchestrator) and `SessionThreatManager` (multi-session score map),
 * and re-exports the public types.
 */

import { canaryPromptBlock, checkCanaries, generateCanaries } from "./threat/canaries.js";
import { classifyData, type DataLabel } from "./threat/classification.js";
import { CryptoAuditTrail } from "./threat/audit-trail.js";
import { THREAT_SCORES, ThreatScorer, type ThreatLevel } from "./threat/scoring.js";
import { ToolChainAnalyzer } from "./threat/tool-chain.js";

export { classifyData, type DataClassification, type DataLabel } from "./threat/classification.js";
export { generateCanaries, canaryPromptBlock, checkCanaries } from "./threat/canaries.js";
export { ThreatScorer, THREAT_SCORES, type ThreatLevel } from "./threat/scoring.js";
export { ToolChainAnalyzer } from "./threat/tool-chain.js";
export { CryptoAuditTrail } from "./threat/audit-trail.js";

// ═══════════════════════════════════════════════════════════════════
// UNIFIED THREAT ENGINE — per-session orchestrator
// ═══════════════════════════════════════════════════════════════════

export class ThreatEngine {
  readonly chain: ToolChainAnalyzer;
  readonly scorer: ThreatScorer;
  readonly audit: CryptoAuditTrail;
  private canaries: string[];
  private sessionId: string;

  constructor(dataDir: string, sessionId: string = "default") {
    this.chain = new ToolChainAnalyzer();
    this.scorer = new ThreatScorer();
    this.audit = new CryptoAuditTrail(dataDir);
    this.canaries = generateCanaries();
    this.sessionId = sessionId;
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

    // Chain analysis (exfiltration + loop detection)
    const chainResult = this.chain.recordAndAnalyze(toolName, args, classification);

    // Record threat events
    if (!allowed) {
      this.scorer.record("security_block", THREAT_SCORES.security_block, `${toolName} blocked`);
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

    if (chainResult.blocked) {
      const score = chainResult.exfil ? THREAT_SCORES.exfiltration_pattern : THREAT_SCORES.loop_detected;
      this.scorer.record(chainResult.exfil ? "exfiltration" : "loop", score, chainResult.reason!);
      this.audit.record({
        sessionId: this.sessionId,
        event: chainResult.exfil ? "exfiltration_detected" : "loop_detected",
        toolName,
        decision: "block",
        reason: chainResult.reason!,
        threatScore: this.scorer.getStatus().score,
        threatLevel: this.scorer.getStatus().level,
      });
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

// ═══════════════════════════════════════════════════════════════════
// SESSION ISOLATION — Per-session threat scoring
// ═══════════════════════════════════════════════════════════════════

export class SessionThreatManager {
  private sessions: Map<string, ThreatScorer> = new Map();

  /** Get or create a ThreatScorer for a session */
  getScorer(sessionId: string): ThreatScorer {
    let scorer = this.sessions.get(sessionId);
    if (!scorer) {
      scorer = new ThreatScorer();
      this.sessions.set(sessionId, scorer);
    }
    return scorer;
  }

  /** Record a threat event for a specific session */
  record(sessionId: string, type: string, score: number, detail: string): { score: number; level: ThreatLevel } {
    return this.getScorer(sessionId).record(type, score, detail);
  }

  /** Check if a session is in restricted mode */
  isRestricted(sessionId: string): boolean {
    const scorer = this.sessions.get(sessionId);
    return scorer ? scorer.isRestricted() : false;
  }

  /** Get security color rating for a session: green/yellow/red */
  getSessionScore(sessionId: string): { color: "green" | "yellow" | "red"; score: number; level: ThreatLevel } {
    const scorer = this.sessions.get(sessionId);
    if (!scorer) return { color: "green", score: 0, level: "normal" };
    const status = scorer.getStatus();
    let color: "green" | "yellow" | "red";
    if (status.score < scorer.ELEVATED_THRESHOLD) {
      color = "green";
    } else if (status.score < scorer.HIGH_THRESHOLD) {
      color = "yellow";
    } else {
      color = "red";
    }
    return { color, score: status.score, level: status.level };
  }

  /** Get all active session IDs */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Get scores for all sessions */
  getAllScores(): Array<{ sessionId: string; color: "green" | "yellow" | "red"; score: number; level: ThreatLevel }> {
    return this.getActiveSessions().map(id => ({
      sessionId: id,
      ...this.getSessionScore(id),
    }));
  }

  /** Reset a specific session */
  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Reset all sessions */
  resetAll(): void {
    this.sessions.clear();
  }
}
