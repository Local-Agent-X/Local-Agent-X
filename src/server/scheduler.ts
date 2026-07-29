/**
 * BackgroundJob + JobScheduler — central registry for periodic background work.
 *
 * Replaces scattered setInterval/setTimeout calls. Every recurring job (memory
 * consolidation, dream check, idle worker cleanup, etc.) registers here so we
 * have one place to reason about cadence, error handling, and shutdown.
 *
 * Errors in any job are logged and swallowed — a misbehaving job never crashes
 * the host process. Optional `shouldRun` gate lets a job no-op without firing
 * (used by dream's 24h+5sessions check).
 *
 * Overlap is handled here too, once, for every registered job — see
 * OverlapPolicy for the two policies and which kind of job needs which.
 */

import { createLogger } from "../logger.js";

const logger = createLogger("server.scheduler");

/**
 * What the scheduler does with a tick that arrives while the previous run of
 * the SAME registration is still in flight.
 *
 * "skip" (the default) — drop the tick. Correct when the next tick is
 * EQUIVALENT to the one in flight: periodic maintenance that reconciles
 * whatever is true *now* (prune the embedding cache, archive old sessions,
 * sweep idle workers, drain a review queue). Nothing is lost by dropping one,
 * and two concurrent passes would race the single-writer state they reconcile.
 * Never queue a follow-up instead: it would fire the instant the slow run
 * finished, against state that run has just reconciled, and for a job that
 * chronically outruns its interval (skill-review polls every 5min against
 * passes observed past 300000ms) the queue degrades into a hot loop — the very
 * pile-up this exists to remove.
 *
 * "self-guarded" — always invoke run(). Correct when the job owns its own
 * exclusion AND its repeated INVOCATION is the recovery mechanism, which makes
 * a scheduler latch actively wrong rather than merely redundant. dream-check is
 * the case that forced the distinction: its lock is a `dreaming` flag in
 * dream-state.json, and shouldDream() force-releases one stuck past 30 minutes
 * — but that recovery is INSIDE the runner, so it only ever executes when a
 * later tick actually calls it. Its canonical run has no timeout and a
 * middleware suspend can park the op in a non-terminal `paused`, so a latch
 * over a run that never settles would make the recovery unreachable and kill
 * memory consolidation for the life of the process. A job like that must decide
 * for itself whether an invocation does real work; the scheduler must not
 * decide for it.
 *
 * There is deliberately no third "force-release the latch after N intervals"
 * policy. For a `skip` job that would start a SECOND run of exactly the work we
 * just argued must never overlap — trading a stalled job for a corrupted one.
 * A wedged slot is made LOUD instead (see STALL_TICKS), never broken open.
 */
export type OverlapPolicy = "skip" | "self-guarded";

/**
 * Consecutive swallowed ticks after which a held slot stops being routine.
 * Past this the run is not slow, it is wedged, and a `skip` job whose run never
 * settles is dead until restart — which must not be visible only at `debug`,
 * suppressed by the default log level.
 */
const STALL_TICKS = 3;

/**
 * Single-slot re-entrancy latch: one run at a time, an attempt that arrives
 * while a run is in flight is SKIPPED. The mechanism behind OverlapPolicy
 * "skip"; see there for why skipping (rather than queuing) is the right policy.
 *
 * Exported because a job that ALSO exposes its own callable entry point needs
 * the same exclusion at that entry point — it must use this latch rather than
 * hand-roll a second flag that can drift from this one.
 */
export interface OverlapGuard {
  /** Claim the slot. False when a run is already in flight. */
  tryEnter(): boolean;
  /** Release the slot. Always call from a `finally`, so a throw can't wedge it. */
  release(): void;
}

export function createOverlapGuard(): OverlapGuard {
  let inFlight = false;
  return {
    tryEnter(): boolean {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    release(): void {
      inFlight = false;
    },
  };
}

export interface BackgroundJob {
  /** Stable identifier for logs. */
  name: string;
  /** Tick interval, milliseconds. */
  intervalMs: number;
  /** Optional one-shot delay before the first interval tick. */
  startupDelayMs?: number;
  /** Optional gate; if it returns false, run() is skipped this tick. */
  shouldRun?: () => boolean | Promise<boolean>;
  /** How a tick that lands on a still-running one is treated. Default "skip";
   *  read OverlapPolicy before choosing, and see JOB_OVERLAP in
   *  background-jobs/index.ts for the policy every registered job declares. */
  overlap?: OverlapPolicy;
  /** The actual work. Errors are caught by the scheduler. */
  run: () => Promise<void> | void;
}

export class JobScheduler {
  private timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];

  register(job: BackgroundJob): void {
    // Per registration, not keyed by job name: two registrations are two
    // independent jobs and must not contend for one slot. The startup timer and
    // the interval deliberately share this latch — a startup run still going
    // must suppress the first interval tick too. A self-guarded job gets no
    // latch at all: its own gate is the exclusion, and the scheduler suppressing
    // an invocation would suppress that gate's recovery path with it.
    const guard = (job.overlap ?? "skip") === "skip" ? createOverlapGuard() : null;
    let claimedAt = 0;
    let stallReported = false;
    const fire = async () => {
      if (guard && !guard.tryEnter()) {
        const heldMs = Date.now() - claimedAt;
        if (!stallReported && heldMs > STALL_TICKS * job.intervalMs) {
          // Once per stall, not once per tick: the point is to make a dead job
          // findable, not to replace one noise problem with another.
          stallReported = true;
          logger.warn(`[${job.name}] run has not settled in ${Math.round(heldMs / 60_000)}min — every tick is skipped until it does`);
        } else {
          logger.debug(`[${job.name}] previous run still in flight, skipping this tick`);
        }
        return;
      }
      claimedAt = Date.now();
      stallReported = false;
      try {
        if (job.shouldRun) {
          const ok = await job.shouldRun();
          if (!ok) return;
        }
        await job.run();
      } catch (e) {
        logger.warn(`[${job.name}] failed:`, (e as Error).message);
      } finally {
        // Covers the shouldRun early return, a synchronous throw, and a
        // rejected run() alike — a job that fails must never wedge its own slot
        // shut for the life of the process.
        guard?.release();
      }
    };
    if (job.startupDelayMs && job.startupDelayMs > 0) {
      this.timers.push(setTimeout(fire, job.startupDelayMs));
    }
    this.timers.push(setInterval(fire, job.intervalMs));
    logger.info(`Registered ${job.name} (every ${Math.round(job.intervalMs / 60_000)}min${job.startupDelayMs ? `, +${Math.round(job.startupDelayMs / 1000)}s startup` : ""})`);
  }

  /**
   * Stop all registered timers. Safe to call multiple times.
   *
   * A run already in flight is not cancelled — a promise can't be — but no
   * further tick can fire once the timers are cleared, and the only thing that
   * run still owns is a closure-local latch its own `finally` releases. So
   * shutdown neither waits on it nor leaks it.
   */
  stopAll(): void {
    for (const t of this.timers) {
      clearInterval(t as ReturnType<typeof setInterval>);
      clearTimeout(t as ReturnType<typeof setTimeout>);
    }
    this.timers = [];
  }
}
