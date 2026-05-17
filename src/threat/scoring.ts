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

export interface ThreatScorerOptions {
  /** Starting trust budget — subtracted from raw load before threshold
   *  comparison. Absorbs early signals on fresh sessions. */
  startingBudget?: number;
  /** Load credit earned per hour since the last threat event. */
  decayPerHour?: number;
  /** Load credit earned per successful turn since the last threat event. */
  decayPerTurn?: number;
  /** Test-only injection point for deterministic clocks. */
  now?: () => number;
}

export class ThreatScorer {
  private events: ThreatEvent[] = [];
  /** Raw accumulated load. Unchanged in shape from the original model:
   *  `rawLoad = rawLoad * DECAY_RATE + score`, floored at the new event's
   *  score. Threshold gating now compares `effectiveLoad`, not `rawLoad`. */
  private rawLoad = 0;
  private lastEventAt: number | null = null;
  private successfulTurnsSinceLastEvent = 0;

  readonly ELEVATED_THRESHOLD = 30;
  readonly HIGH_THRESHOLD = 60;
  readonly CRITICAL_THRESHOLD = 85;
  private readonly DECAY_RATE = 0.95;  // Score decays 5% per event check
  private readonly MAX_EVENTS = 200;

  readonly startingBudget: number;
  readonly decayPerHour: number;
  readonly decayPerTurn: number;
  private readonly now: () => number;

  constructor(opts: ThreatScorerOptions = {}) {
    this.startingBudget = opts.startingBudget ?? 60;
    this.decayPerHour = opts.decayPerHour ?? 5;
    this.decayPerTurn = opts.decayPerTurn ?? 1;
    this.now = opts.now ?? Date.now;
  }

  /** Record a threat event and return current effective score + level */
  record(type: string, score: number, detail: string): { score: number; level: ThreatLevel } {
    const t = this.now();
    this.events.push({ type, score, timestamp: t, detail });
    if (this.events.length > this.MAX_EVENTS) this.events.shift();

    // Apply decay — older events matter less
    this.rawLoad = this.rawLoad * this.DECAY_RATE + score;
    if (this.rawLoad < score) this.rawLoad = score;

    // A real threat event resets the decay-credit clock: time + calm turns
    // accrued before this signal don't excuse it.
    this.lastEventAt = t;
    this.successfulTurnsSinceLastEvent = 0;
    return this.getStatus();
  }

  /** Mark a successful turn so trust regenerates with use. Decays the
   *  per-turn side of the credit (we take max(timeCredit, turnCredit)). */
  recordSuccessfulTurn(): void {
    this.successfulTurnsSinceLastEvent += 1;
  }

  // ─────────────────────────────────────────────────────────────────
  // Effective load model
  //
  // Fresh installs were tripping the threat gate on a single legitimate
  // sensitive-topic research session because they had zero accumulated
  // trust against which to weigh the signal. This is wrong: the user
  // with the LEAST history was punished hardest.
  //
  // Fix without weakening the engine:
  //   1. `startingBudget` — a constant absorption capacity subtracted
  //      from raw load. Fresh sessions get headroom; one suspicious
  //      keyword does not cross the gate. Threshold value unchanged.
  //   2. Decay credit — load drains over wall-clock time AND over
  //      successful turns since the last event. Whichever is stronger
  //      wins, so 3 hours quiet OR 50 calm turns both restore trust.
  //
  // What this does NOT do:
  //   - Lower any threshold value (HIGH_THRESHOLD stays 60).
  //   - Reduce any signal score (THREAT_SCORES unchanged).
  //   - Disable the engine for any session class.
  //   - Special-case any keyword or topic.
  //
  // Elevation remains reachable on a fresh install: enough real signal
  // overruns the budget + decay credit. We widened the gap between
  // "one suspicious phrase" and "restricted", not removed the gate.
  // ─────────────────────────────────────────────────────────────────
  private decayCredit(now: number): number {
    if (this.lastEventAt === null) return 0;
    const hoursElapsed = Math.max(0, (now - this.lastEventAt) / (1000 * 60 * 60));
    const timeCredit = hoursElapsed * this.decayPerHour;
    const turnCredit = this.successfulTurnsSinceLastEvent * this.decayPerTurn;
    return Math.max(timeCredit, turnCredit);
  }

  /** Effective load — what the gate compares to the threshold. */
  private effectiveLoad(now: number = this.now()): number {
    const credit = this.startingBudget + this.decayCredit(now);
    return Math.max(0, this.rawLoad - credit);
  }

  /** Get current threat level — based on effective load (budget + decay). */
  getStatus(): { score: number; level: ThreatLevel } {
    const s = Math.round(this.effectiveLoad());
    let level: ThreatLevel = "normal";
    if (s >= this.CRITICAL_THRESHOLD) level = "critical";
    else if (s >= this.HIGH_THRESHOLD) level = "high";
    else if (s >= this.ELEVATED_THRESHOLD) level = "elevated";
    return { score: s, level };
  }

  /** Check if we should restrict operations — uses effective load. */
  isRestricted(): boolean {
    return this.effectiveLoad() >= this.HIGH_THRESHOLD;
  }

  /** Raw accumulated load before budget/decay credits — for diagnostics. */
  getRawLoad(): number {
    return this.rawLoad;
  }

  /** Get recent threat events for audit */
  getEvents(): ThreatEvent[] {
    return [...this.events];
  }

  reset(): void {
    this.events = [];
    this.rawLoad = 0;
    this.lastEventAt = null;
    this.successfulTurnsSinceLastEvent = 0;
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
