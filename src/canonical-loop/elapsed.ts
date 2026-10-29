/**
 * Elapsed time for what a turn records: model time, tool time, dispatch time.
 * Date.now() is the wall clock, and the wall clock steps: an NTP correction,
 * a VM or container syncing to its host, a laptop waking. A step back during
 * a model call made modelMs negative, the turn commit refused its own row as
 * an invalid envelope, and the op failed (TB2 build-pmars, 2026-10-28: the
 * container's clock went back about 0.2 s during turn 2). performance.now()
 * never goes back.
 */
export const monotonicNow = (): number => performance.now();

/** Whole milliseconds since a `monotonicNow()` reading; never negative. */
export const elapsedMs = (since: number): number => Math.round(performance.now() - since);
