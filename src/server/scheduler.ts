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
 */

import { createLogger } from "../logger.js";

const logger = createLogger("server.scheduler");

export interface BackgroundJob {
  /** Stable identifier for logs. */
  name: string;
  /** Tick interval, milliseconds. */
  intervalMs: number;
  /** Optional one-shot delay before the first interval tick. */
  startupDelayMs?: number;
  /** Optional gate; if it returns false, run() is skipped this tick. */
  shouldRun?: () => boolean | Promise<boolean>;
  /** The actual work. Errors are caught by the scheduler. */
  run: () => Promise<void> | void;
}

export class JobScheduler {
  private timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];

  register(job: BackgroundJob): void {
    const fire = async () => {
      try {
        if (job.shouldRun) {
          const ok = await job.shouldRun();
          if (!ok) return;
        }
        await job.run();
      } catch (e) {
        logger.warn(`[${job.name}] failed:`, (e as Error).message);
      }
    };
    if (job.startupDelayMs && job.startupDelayMs > 0) {
      this.timers.push(setTimeout(fire, job.startupDelayMs));
    }
    this.timers.push(setInterval(fire, job.intervalMs));
    logger.info(`Registered ${job.name} (every ${Math.round(job.intervalMs / 60_000)}min${job.startupDelayMs ? `, +${Math.round(job.startupDelayMs / 1000)}s startup` : ""})`);
  }

  /** Stop all registered timers. Safe to call multiple times. */
  stopAll(): void {
    for (const t of this.timers) {
      clearInterval(t as ReturnType<typeof setInterval>);
      clearTimeout(t as ReturnType<typeof setTimeout>);
    }
    this.timers = [];
  }
}
