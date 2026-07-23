// ═══════════════════════════════════════════════════════════════════
// ADAPTIVE THREAT SCORING — Real-time per-session risk score
// ═══════════════════════════════════════════════════════════════════

export type ThreatLevel = "normal" | "elevated" | "high" | "critical";

/**
 * Event types that are DETERMINISTIC EVIDENCE of data actually being at risk —
 * each one is grounded in observed bytes, not temporal correlation or another
 * layer's block decision:
 *
 * - "exfiltration"         — secret-shaped content was ACTUALLY IN an outbound
 *                            payload (URL/body/headers). Data-flow proof, not
 *                            a read-then-send timing heuristic.
 * - "credential_in_output" — a credential materially appeared in a tool result
 *                            the model now holds in context.
 * - "secrets_in_output"    — same, for other secret-shaped content.
 * - "canary_tripped"       — a canary token from the system prompt appeared in
 *                            model output: confirmed prompt-injection exfil.
 *
 * Deliberately NOT evidence: "loop" (covers both runaway loops and the
 * encoding-prep block — behavioral heuristics), "exfiltration_staging"
 * (temporal correlation; 0 true positives in 7 weeks), "security_block" /
 * "policy_block" (another layer's decision, whose false positives amplified
 * into restriction — live failure 2026-07-23).
 *
 * Accumulated load alone (≥ HIGH_THRESHOLD) no longer restricts the session;
 * it must be corroborated by at least one recorded event from this set.
 */
export const DETERMINISTIC_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  "exfiltration",
  "credential_in_output",
  "secrets_in_output",
  "canary_tripped",
]);

export interface ThreatEvent {
  type: string;
  score: number;
  timestamp: number;
  detail: string;
}

export interface ThreatScorerState {
  events: Array<Omit<ThreatEvent, "detail">>;
  rawLoad: number;
  lastEventAt: number | null;
  successfulTurnsSinceLastEvent: number;
  confirmedBreach: boolean;
  options: { startingBudget: number; decayPerHour: number; decayPerTurn: number };
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
  /** Latch: a confirmed breach was observed. Unlike the probabilistic load
   *  model, this cannot be excused by trust budget or decay. */
  private confirmedBreach = false;

  /** Event types that are PROOF of compromise, not a probabilistic signal.
   *  A canary token leaving the session is a confirmed prompt-injection
   *  exfiltration — no starting budget or decay credit should absorb it, so
   *  these latch the session into restricted mode on the first occurrence. */
  private static readonly CONFIRMED_BREACH_TYPES: ReadonlySet<string> = new Set([
    "canary_tripped",
  ]);

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

    // A confirmed breach (e.g. a tripped canary) is not a probabilistic
    // signal the budget model can absorb — latch the session as restricted.
    if (ThreatScorer.CONFIRMED_BREACH_TYPES.has(type)) this.confirmedBreach = true;

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

  /** Get current threat level — based on effective load (budget + decay).
   *  A confirmed breach floors the level at `critical` regardless of load. */
  getStatus(): { score: number; level: ThreatLevel } {
    const s = Math.round(this.effectiveLoad());
    let level: ThreatLevel = "normal";
    if (this.confirmedBreach || s >= this.CRITICAL_THRESHOLD) level = "critical";
    else if (s >= this.HIGH_THRESHOLD) level = "high";
    else if (s >= this.ELEVATED_THRESHOLD) level = "elevated";
    return { score: s, level };
  }

  /** Check if we should restrict operations — uses effective load, but a
   *  confirmed breach latches restriction on regardless of trust budget.
   *  Load alone is not enough: heuristic signals (sensitive reads, shell
   *  commands, …) can accumulate past the threshold on a legitimate session,
   *  so restriction additionally requires at least one recorded event whose
   *  type is deterministic evidence (see DETERMINISTIC_EVIDENCE_TYPES). */
  isRestricted(): boolean {
    if (this.confirmedBreach) return true;
    return this.effectiveLoad() >= this.HIGH_THRESHOLD && this.getEvidenceTypes().length > 0;
  }

  /** Unique deterministic-evidence event types recorded this session, in
   *  first-seen order. Non-empty is a precondition for load-based restriction;
   *  the tool-policy pack also uses it to tell the user WHAT evidence tripped
   *  the restriction instead of a generic (or false) failure message. */
  getEvidenceTypes(): string[] {
    const seen: string[] = [];
    for (const e of this.events) {
      if (DETERMINISTIC_EVIDENCE_TYPES.has(e.type) && !seen.includes(e.type)) seen.push(e.type);
    }
    return seen;
  }

  /**
   * Clear ONLY the confirmed-breach latch. Load, decay clock, and event log are
   * left untouched — if residual effective load still exceeds HIGH_THRESHOLD the
   * session stays restricted on its own merits.
   *
   * SECURITY LATCH — reachable ONLY from ThreatEngine.approveRecovery (the
   * explicit user-authorized `/approve` recovery path). This reverses the one
   * restriction the trust-budget model is forbidden from excusing (a tripped
   * canary is PROOF of exfiltration, not a probabilistic signal), so it must not
   * be lifted by ordinary scorer activity: no record() of a benign event, no
   * recordSuccessfulTurn(), and no decay tick clears it — only this call or a
   * full reset() (new-session teardown). Returns whether a breach was in effect,
   * so the caller can distinguish a real recovery from a no-op.
   */
  clearConfirmedBreach(): boolean {
    const was = this.confirmedBreach;
    this.confirmedBreach = false;
    return was;
  }

  /** Raw accumulated load before budget/decay credits — for diagnostics. */
  getRawLoad(): number {
    return this.rawLoad;
  }

  /** Get recent threat events for audit */
  getEvents(): ThreatEvent[] {
    return [...this.events];
  }

  snapshot(): ThreatScorerState {
    return {
      events: this.events.map(({ type, score, timestamp }) => ({ type, score, timestamp })),
      rawLoad: this.rawLoad,
      lastEventAt: this.lastEventAt,
      successfulTurnsSinceLastEvent: this.successfulTurnsSinceLastEvent,
      confirmedBreach: this.confirmedBreach,
      options: {
        startingBudget: this.startingBudget,
        decayPerHour: this.decayPerHour,
        decayPerTurn: this.decayPerTurn,
      },
    };
  }

  restore(state: ThreatScorerState): void {
    if (state.options.startingBudget !== this.startingBudget
      || state.options.decayPerHour !== this.decayPerHour
      || state.options.decayPerTurn !== this.decayPerTurn) {
      throw new Error("threat scorer configuration changed since submission");
    }
    if (!Array.isArray(state.events) || state.events.length > this.MAX_EVENTS
      || !Number.isFinite(state.rawLoad) || state.rawLoad < 0
      || (state.lastEventAt !== null && (!Number.isFinite(state.lastEventAt) || state.lastEventAt < 0))
      || !Number.isInteger(state.successfulTurnsSinceLastEvent) || state.successfulTurnsSinceLastEvent < 0
      || typeof state.confirmedBreach !== "boolean") {
      throw new Error("invalid persisted threat scorer state");
    }
    this.events = state.events.map(event => {
      if (!event || typeof event.type !== "string" || !event.type || event.type.length > 128
        || !Number.isFinite(event.score) || event.score < 0
        || !Number.isFinite(event.timestamp) || event.timestamp < 0) {
        throw new Error("invalid persisted threat event");
      }
      return { ...event, detail: "[recovered]" };
    });
    this.rawLoad = state.rawLoad;
    this.lastEventAt = state.lastEventAt;
    this.successfulTurnsSinceLastEvent = state.successfulTurnsSinceLastEvent;
    this.confirmedBreach = state.confirmedBreach;
  }

  reset(): void {
    this.events = [];
    this.rawLoad = 0;
    this.lastEventAt = null;
    this.successfulTurnsSinceLastEvent = 0;
    this.confirmedBreach = false;
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
  // Temporal staging: a sensitive read preceded an external call but no secret
  // was on the wire. A soft behavioral signal — well below a single-event
  // restriction, so one read-then-call is harmless but a persistent pattern
  // accumulates toward elevated/restricted.
  exfiltration_staging: 12,
  canary_tripped: 50,
  security_block: 10,
  policy_block: 8,
  loop_detected: 15,
  injection_detected: 20,

  // Critical events
  credential_in_output: 30,
  sensitive_data_external: 35,
};
