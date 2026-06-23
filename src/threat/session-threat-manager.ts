/**
 * SESSION ISOLATION — per-session threat scoring.
 *
 * Multi-session score map: one ThreatScorer per session id, plus the
 * green/yellow/red rollup the UI reads. Split out of threat-engine.ts (the
 * per-session orchestrator) so each file owns a single responsibility; the
 * engine re-exports this so the import path is unchanged.
 */

import { ThreatScorer, type ThreatLevel } from "./scoring.js";
import { readThreatScorerOptions } from "./scorer-options.js";

export class SessionThreatManager {
  private sessions: Map<string, ThreatScorer> = new Map();

  /** Get or create a ThreatScorer for a session */
  getScorer(sessionId: string): ThreatScorer {
    let scorer = this.sessions.get(sessionId);
    if (!scorer) {
      scorer = new ThreatScorer(readThreatScorerOptions());
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
