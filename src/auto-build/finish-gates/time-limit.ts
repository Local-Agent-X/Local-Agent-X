/**
 * How long a build's finish checks may take: no longer than building the app
 * did. The owner's ruling (2026-11-27), after a Grok build spent hours of
 * finish fixes on one fix chunk and a GPT build about six hours over five
 * rounds (label-check-grok, label-check-sol). When the time is up, the fix
 * chunks not yet started are not started, and what they would have fixed goes
 * on the owner's list with the rest.
 *
 * Building time is the plan's chunks only, summed over every run of the build
 * (failure-recovery.ts recordBuildTime): a pause, a restart or the owner away
 * for a night does not count. The limit is set once, when the finish checks
 * start, and kept in their saved progress, so a resume does not reset it. It
 * is a clock time, so a resume moves it on by the time since the progress was
 * last saved: label-check-grok, paused an hour into its finish checks, came
 * back to "their time is up" and ended without checking the app again
 * (2026-11-27).
 */
import { buildTimeMs } from "../failure-recovery.js";

/** A build too quick to measure, or measured before building time was kept,
 *  still gets this long. */
export const MIN_FINISH_MS = 60 * 60_000;

/** When this build's finish checks must stop starting new work (ISO time).
 *  `savedAt`: when the saved deadline was last saved; the time since is time
 *  the build was stopped, and does not count. */
export function finishDeadline(projectDir: string, saved: string | undefined, now = Date.now(), savedAt?: string): string {
  if (saved && !Number.isNaN(Date.parse(saved))) {
    const stopped = savedAt && !Number.isNaN(Date.parse(savedAt)) ? Math.max(0, now - Date.parse(savedAt)) : 0;
    return new Date(Date.parse(saved) + stopped).toISOString();
  }
  return new Date(now + Math.max(buildTimeMs(projectDir), MIN_FINISH_MS)).toISOString();
}

export function timeIsUp(deadline: string, now = Date.now()): boolean {
  return now >= Date.parse(deadline);
}

/** "2 h 05 min", for what the owner reads. */
export function spanOf(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
