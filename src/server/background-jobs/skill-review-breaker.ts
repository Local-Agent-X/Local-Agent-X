/**
 * Consecutive-failure breaker for the skill-review job.
 *
 * Why: on the night of Aug 31 every 5-minute pass failed for hours — full
 * main-model spend per attempt (~110-245k tokens), zero protocols written.
 * 4d3f2de5 made those failures COUNT (reviewFailure by stopReason), but
 * nothing slowed the cadence: an outage upstream of the fork (provider auth, a
 * poisoned transcript, a middleware loop) burned a whole review every tick
 * until a human noticed.
 *
 * The machine: BREAKER_BACKOFF_AFTER consecutive all-failure passes start
 * stretching the wait between scheduled passes — 2x the poll interval, then
 * 4x, 8x — capped at BREAKER_MAX_DELAY_MS; a streak of BREAKER_PARK_AFTER
 * parks the job until server restart or a successful forced pass. Any pass
 * that completes at least one review resets everything.
 *
 * Deliberately in-memory: a restart clearing the breaker IS the documented
 * recovery path, and persisting spend-protection state would be a second
 * source of truth about job health. The breaker gates SPEND only — the
 * per-review failure logging in skill-review.ts is untouched, and every state
 * change logs WHY through the job's own logger.
 *
 * This is state, not scheduling. The one consumer is runSkillReviewPass
 * (./skill-review.ts), which consults blocks() at its entry — the seam the
 * JobScheduler tick and any manual caller already share. The scheduler's
 * setInterval keeps firing at the base cadence; a tick that lands inside a
 * backoff window is refused there. No new timers, no new job framework.
 */
import type { Logger } from "../../logger.js";

export type SkillReviewBreakerPhase = "active" | "backing-off" | "parked";

export interface SkillReviewBreakerState {
  phase: SkillReviewBreakerPhase;
  /** Consecutive passes that attempted at least one review and completed none. */
  streak: number;
  /** Epoch ms before which blocks() refuses a scheduled pass while backing
   *  off; 0 = no backoff pending. Meaningless once parked — parked blocks
   *  unconditionally. */
  nextEligibleAt: number;
}

/** Consecutive failed passes before the cadence starts stretching. */
export const BREAKER_BACKOFF_AFTER = 3;
/** Consecutive failed passes after which the job parks until restart or a
 *  successful forced pass. */
export const BREAKER_PARK_AFTER = 10;
/** Ceiling on the backoff delay (streak 6 with the 5-minute base reaches it). */
export const BREAKER_MAX_DELAY_MS = 60 * 60 * 1000;

export class SkillReviewBreaker {
  private streak = 0;
  private nextEligibleAt = 0;
  private parked = false;

  constructor(
    private readonly baseIntervalMs: number,
    private readonly log: Logger,
  ) {}

  state(): SkillReviewBreakerState {
    return { phase: this.phase(), streak: this.streak, nextEligibleAt: this.nextEligibleAt };
  }

  /** Why a scheduled pass may not run now, or null when it may. Forced/manual
   *  runs must not consult this — the breaker exists to stop unattended
   *  spend, never to refuse a human. Skipped ticks log at debug: the state
   *  CHANGE already warned once, and repeating it per tick would recreate the
   *  noise problem the breaker exists to end. */
  blocks(now: number = Date.now()): "parked" | "breaker-backoff" | null {
    if (this.parked) {
      this.log.debug(`[skill-review] breaker parked (streak ${this.streak}) — scheduled pass skipped`);
      return "parked";
    }
    if (now < this.nextEligibleAt) {
      this.log.debug(`[skill-review] breaker backing off (streak ${this.streak}) — next pass eligible in ${Math.ceil((this.nextEligibleAt - now) / 1000)}s`);
      return "breaker-backoff";
    }
    return null;
  }

  /** A pass completed at least one review: the spend bought something. Full
   *  reset, park included — a successful forced pass is what revives a parked
   *  job without a restart. */
  recordSuccess(): void {
    const was = this.phase();
    const streak = this.streak;
    this.reset();
    if (was !== "active") {
      this.log.info(`[skill-review] breaker reset: a pass succeeded (was ${was}, streak ${streak}) — normal cadence resumes`);
    }
  }

  /** A pass attempted at least one review and completed none. */
  recordFailure(now: number = Date.now()): void {
    this.streak++;
    // Already parked: as slow as it gets, and the park line was logged once.
    if (this.parked) return;
    if (this.streak >= BREAKER_PARK_AFTER) {
      this.parked = true;
      this.log.warn(`[skill-review] breaker PARKED: ${this.streak} consecutive failed passes — no further scheduled reviews until server restart or a successful forced pass`);
      return;
    }
    if (this.streak >= BREAKER_BACKOFF_AFTER) {
      const delayMs = Math.min(this.baseIntervalMs * 2 ** (this.streak - BREAKER_BACKOFF_AFTER + 1), BREAKER_MAX_DELAY_MS);
      this.nextEligibleAt = now + delayMs;
      this.log.warn(`[skill-review] breaker backing off: ${this.streak} consecutive failed passes — next scheduled pass no sooner than ${Math.round(delayMs / 60_000)}min from now (spend paused; failure logging untouched)`);
    }
  }

  /** Back to the pristine boot state. */
  reset(): void {
    this.streak = 0;
    this.nextEligibleAt = 0;
    this.parked = false;
  }

  private phase(): SkillReviewBreakerPhase {
    if (this.parked) return "parked";
    return this.streak >= BREAKER_BACKOFF_AFTER ? "backing-off" : "active";
  }
}
