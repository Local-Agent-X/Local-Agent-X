/**
 * The pauses a start is made of.
 *
 * The event-loop sentinel reports a stall of five seconds or more. A start is
 * mostly made of shorter ones: a second comparing every chat, a second and a
 * half reading the op store. Each is a stretch in which the window that just
 * opened does not answer, and none was ever logged, so a start could only be
 * measured by profiling it (2026-11-24, 2026-11-27) or by reading the gaps
 * between other subsystems' timestamps (2026-11-28, the sync pull).
 *
 * For the first minutes after the server starts, and only then, every late
 * sample past a much lower bar gets one info line, with how long after the
 * start it ended: the lines logged just before it say what was running. When
 * the window closes, one line totals them, so two starts can be compared by
 * reading two lines. After that this does nothing and logs nothing.
 */
import type { Logger } from "../logger.js";

export interface StartupPausesOptions {
  /** When the server started, on the clock `sample` is given times from. */
  startedAt: number;
  /** How long after `startedAt` pauses are reported. 0 or less: never. */
  windowMs: number;
  /** The shortest pause worth a line. */
  minMs: number;
  log: Pick<Logger, "info">;
}

export interface StartupPauses {
  /**
   * One sample of the event loop: it arrived `lagMs` late, at `at`.
   * `reportedAsStall` says the sentinel is logging this one itself, so it is
   * counted in the total and not given a second line.
   */
  sample(lagMs: number, at: number, reportedAsStall: boolean): void;
}

export function createStartupPauses(opts: StartupPausesOptions): StartupPauses {
  const { startedAt, windowMs, minMs, log } = opts;
  let open = windowMs > 0;
  let count = 0;
  let totalMs = 0;
  let longestMs = 0;
  const windowS = Math.round(windowMs / 1000);

  return {
    sample(lagMs, at, reportedAsStall) {
      if (!open) return;
      const sinceStartMs = at - startedAt;
      if (sinceStartMs > windowMs) {
        open = false;
        log.info(count === 0
          ? `[loop-sentinel] start-up: no pause of ${minMs}ms or more in the first ${windowS}s`
          : `[loop-sentinel] start-up: ${count} pause(s) of ${minMs}ms or more in the first ${windowS}s, ${totalMs}ms in all, the longest ${longestMs}ms`);
        return;
      }
      if (lagMs < minMs) return;
      count++;
      totalMs += lagMs;
      longestMs = Math.max(longestMs, lagMs);
      if (!reportedAsStall) {
        log.info(`[loop-sentinel] start-up pause: the event loop was held for ${lagMs}ms, ending ${(sinceStartMs / 1000).toFixed(1)}s after start`);
      }
    },
  };
}
