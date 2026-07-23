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

import { registrableDomain } from "../browser/csp-policy.js";
import {
  canaryPromptBlock, checkCanaries, generateCanaries, registerSessionCanaries,
  remintSessionCanaries, recordCanaryRecoveryAudit, markSessionBreach, clearSessionBreach,
} from "./canaries.js";
import { classifyData, type DataLabel } from "./classification.js";
import { CryptoAuditTrail, getSharedAuditTrail } from "./audit-trail.js";
import { THREAT_SCORES, ThreatScorer, type ThreatLevel, type ThreatScorerState } from "./scoring.js";
import { readThreatScorerOptions } from "./scorer-options.js";
import { ToolChainAnalyzer, type ToolChainState } from "./tool-chain.js";
import { restoreLastBlockedFingerprint } from "./consent-store.js";
import { emitPreScoreChainAudit } from "./threat-audit-events.js";

export interface ThreatEngineState {
  scorer: ThreatScorerState;
  chain: ToolChainState;
  canaries: string[];
  /** Registrable domains implicated as exfiltration sinks. Optional so state
   *  persisted by older versions (which lacks the field) restores cleanly —
   *  missing means "none recorded", and a restricted session restored that way
   *  falls back to the conservative deny-all-external behavior. */
  implicatedSinks?: string[];
}

/** Registrable domain (eTLD+1) of an external sink target, or the bare
 *  lowercased hostname when eTLD+1 does not apply (IP literals, single-label
 *  hosts), or null when the target has no parseable host. The tool-policy
 *  threat pack MUST derive the domain of a call's target with this same
 *  function so implicated-sink matching can never drift. */
export function externalSinkDomain(target: string): string | null {
  try {
    const host = new URL(target).hostname;
    if (!host) return null;
    return registrableDomain(host) ?? host.toLowerCase();
  } catch {
    return null;
  }
}

export { _invalidateThreatSettingsCacheForTests } from "./scorer-options.js";

export { classifyData, type DataClassification, type DataLabel } from "./classification.js";
export { generateCanaries, canaryPromptBlock, checkCanaries, checkCanariesInPayload, getSessionCanaries, registerSessionCanaries, clearSessionCanaries, isSessionBreached, recoverSessionBreach } from "./canaries.js";
export { ThreatScorer, THREAT_SCORES, DETERMINISTIC_EVIDENCE_TYPES, type ThreatLevel } from "./scoring.js";
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
  /** Registrable domains of external sinks implicated by exfiltration evidence
   *  (a blocked outbound call whose payload carried secret-shaped content).
   *  Restriction is scoped to these domains when non-empty; credential/secret
   *  -in-output and canary evidence has no attributable sink, so a session
   *  restricted on those alone keeps the conservative deny-all behavior. */
  private implicatedSinks = new Set<string>();
  private static readonly MAX_IMPLICATED_SINKS = 50;

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
      implicatedSinks: [...this.implicatedSinks],
    };
  }

  restore(state: ThreatEngineState): void {
    if (!Array.isArray(state.canaries) || state.canaries.length === 0
      || state.canaries.some(canary => typeof canary !== "string" || canary.length < 8)) {
      throw new Error("invalid persisted threat canary state");
    }
    // Optional field — absent in state persisted before sink scoping existed.
    // Missing must not throw: restore to "none recorded" (conservative
    // deny-all-external while restricted).
    if (state.implicatedSinks !== undefined) {
      if (!Array.isArray(state.implicatedSinks)
        || state.implicatedSinks.length > ThreatEngine.MAX_IMPLICATED_SINKS
        || state.implicatedSinks.some(d => typeof d !== "string" || !d || d.length > 253)) {
        throw new Error("invalid persisted implicated-sink state");
      }
    }
    this.scorer.restore(state.scorer);
    this.chain.restore(state.chain);
    this.implicatedSinks = new Set(state.implicatedSinks ?? []);
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

    // Pre-score audit events (blocked-by-other-layer / staging observability /
    // consent-allowed exfil) — emitted but NEVER scored. See threat-audit-events.ts
    // for the full rationale (staging is a 0-true-positive heuristic; another
    // layer's block must not feed this scorer).
    emitPreScoreChainAudit(this.audit, this.scorer, this.sessionId, toolName, allowed, alreadyRestricted, chainResult);

    if (chainResult.blocked) {
      // Exfiltration evidence names its sink — record the registrable domain so
      // restriction can be scoped to the implicated destination instead of
      // denying the entire external internet. Recorded even while already
      // restricted (it only tightens the scoped set; it does not touch the
      // scorer, so it cannot reset the recovery clock).
      if (chainResult.exfil && this.implicatedSinks.size < ThreatEngine.MAX_IMPLICATED_SINKS) {
        const sinkDomain = externalSinkDomain(chainResult.exfil.sink.target);
        if (sinkDomain) this.implicatedSinks.add(sinkDomain);
      }
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
      // Session-scoped mirror of the confirmed breach (the scorer latch is
      // per-engine; this survives across the per-turn engines the chat path
      // rebuilds) so the `/approve` handler can find and lift the latch.
      markSessionBreach(this.sessionId);
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

  /**
   * User-authorized recovery from a confirmed-breach (canary) latch — the
   * `/approve` path. A tripped canary latches the session restricted and the
   * trust-budget model is forbidden from excusing it (it's proof, not a
   * probabilistic signal), so the only in-session exit short of a full reset is
   * an explicit user authorization. This is that exit, and the SOLE caller of
   * scorer.clearConfirmedBreach(). It:
   *   1. Clears the breach latch (load/decay untouched — if residual effective
   *      load still exceeds HIGH_THRESHOLD the session stays restricted on its
   *      own merits), and clears the session-scoped breach signal.
   *   2. Re-mints the session's canaries. The old tokens leaked into model
   *      output, so the model now KNOWS them — worthless as a tripwire. We
   *      replace this.canaries AND the shared registry (remintSessionCanaries →
   *      registerSessionCanaries, the exact set the egress gate reads) so future
   *      output/egress is guarded by tokens the model has never seen.
   *   3. Writes a tamper-evident recovery event on the SAME audit chain as the
   *      trip — never logging any canary token, old or new (the reason is
   *      redacted of any leaked token first).
   * Returns whether a breach latch was actually in effect, so the caller can
   * tailor its reply (an /approve with no active latch is a plain consent grant).
   */
  approveRecovery(reason: string): { recovered: boolean } {
    const old = this.canaries;
    const recovered = this.scorer.clearConfirmedBreach();
    clearSessionBreach(this.sessionId);
    // Burn the leaked tokens: mint fresh, register, and adopt into the set this
    // engine embeds in the system prompt + watches in checkOutput.
    this.canaries = remintSessionCanaries(this.sessionId);
    // Defensive: a user could paste a leaked (now-old) token into their reason.
    // Redact it so the NEVER-log-a-canary invariant holds even for caller text.
    let safeReason = reason;
    for (const c of old) safeReason = safeReason.split(c).join("[redacted-canary]");
    recordCanaryRecoveryAudit(this.sessionId, safeReason);
    return { recovered };
  }

  /** What the current restriction is grounded on: the deterministic evidence
   *  event types recorded, and the implicated sink domains (empty when the
   *  evidence has no attributable external destination). The tool-policy pack
   *  uses this to scope the deny to implicated sinks and to tell the user the
   *  true cause instead of a fake network failure. */
  getRestrictionEvidence(): { types: string[]; sinks: string[] } {
    return { types: this.scorer.getEvidenceTypes(), sinks: [...this.implicatedSinks] };
  }

  /** Reset for new session */
  reset(newSessionId?: string): void {
    this.chain.reset();
    this.scorer.reset();
    clearSessionBreach(this.sessionId);
    this.implicatedSinks.clear();
    this.canaries = generateCanaries();
    if (newSessionId) this.sessionId = newSessionId;
    registerSessionCanaries(this.sessionId, this.canaries);
  }
}
