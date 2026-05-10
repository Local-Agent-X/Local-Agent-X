// ═══════════════════════════════════════════════════════════════════
// ADAPTIVE THREAT SCORING — Real-time per-session risk score
// ═══════════════════════════════════════════════════════════════════

export type ThreatLevel = "normal" | "elevated" | "high" | "critical";

interface ThreatEvent {
  type: string;
  score: number;
  timestamp: number;
  detail: string;
}

export class ThreatScorer {
  private events: ThreatEvent[] = [];
  private baseScore = 0;
  readonly ELEVATED_THRESHOLD = 30;
  readonly HIGH_THRESHOLD = 60;
  readonly CRITICAL_THRESHOLD = 85;
  private readonly DECAY_RATE = 0.95;  // Score decays 5% per event check
  private readonly MAX_EVENTS = 200;

  /** Record a threat event and return current score + level */
  record(type: string, score: number, detail: string): { score: number; level: ThreatLevel } {
    this.events.push({ type, score, timestamp: Date.now(), detail });
    if (this.events.length > this.MAX_EVENTS) this.events.shift();

    // Apply decay — older events matter less
    this.baseScore = this.baseScore * this.DECAY_RATE + score;
    if (this.baseScore < score) this.baseScore = score;
    return this.getStatus();
  }

  /** Get current threat level */
  getStatus(): { score: number; level: ThreatLevel } {
    const s = Math.round(this.baseScore);
    let level: ThreatLevel = "normal";
    if (s >= this.CRITICAL_THRESHOLD) level = "critical";
    else if (s >= this.HIGH_THRESHOLD) level = "high";
    else if (s >= this.ELEVATED_THRESHOLD) level = "elevated";
    return { score: s, level };
  }

  /** Check if we should restrict operations */
  isRestricted(): boolean {
    return this.baseScore >= this.HIGH_THRESHOLD;
  }

  /** Get recent threat events for audit */
  getEvents(): ThreatEvent[] {
    return [...this.events];
  }

  reset(): void {
    this.events = [];
    this.baseScore = 0;
  }
}

// Pre-defined threat event scores
export const THREAT_SCORES = {
  // Low-risk events (informational)
  tool_call: 0,
  file_read: 1,
  web_fetch: 2,

  // Medium-risk events
  sensitive_file_read: 8,
  shell_command: 5,
  browser_navigate: 3,
  external_http: 5,

  // High-risk events
  exfiltration_pattern: 25,
  canary_tripped: 50,
  security_block: 10,
  policy_block: 8,
  loop_detected: 15,
  injection_detected: 20,

  // Critical events
  credential_in_output: 30,
  sensitive_data_external: 35,
};
