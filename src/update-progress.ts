/**
 * How far an update has got, for the progress bar (GET /api/updates/progress).
 *
 * Both routes report the step they are in; each step carries a fixed share of
 * the bar, set from the update timed on 2026-11-15 (the build is most of it).
 * Inside a step the bar advances with elapsed time against how long that step
 * usually takes, never past 90 % of its share until the step ends, so it moves
 * without claiming to be done. The build's usual time is this machine's own
 * last measured build, kept in the data dir. A step that is skipped (no
 * dependency change) hands its share over at once. The percent never goes
 * backwards within one run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLaxDir } from "./lax-data-dir.js";

export type UpdateStep = "fetch" | "copy" | "deps" | "build" | "test" | "land";
export type UpdateMode = "idle" | "preparing" | "installing" | "ready";

const STEPS: ReadonlyArray<{ step: UpdateStep; share: number; label: string; usualMs: number }> = [
  { step: "fetch", share: 5, label: "Downloading the new version…", usualMs: 4_000 },
  { step: "copy", share: 3, label: "Setting up a test copy…", usualMs: 3_000 },
  { step: "deps", share: 15, label: "Installing new dependencies…", usualMs: 90_000 },
  { step: "build", share: 55, label: "Building the new version…", usualMs: 50_000 },
  { step: "test", share: 7, label: "Starting the new version to test it…", usualMs: 8_000 },
  { step: "land", share: 10, label: "Installing…", usualMs: 6_000 },
];
const DONE_SHARE = 5;
const IN_STEP_CAP = 0.9;

interface Run { mode: "preparing" | "installing"; index: number; stepStartedAt: number; percent: number }
let run: Run | null = null;

export interface UpdateProgress { mode: UpdateMode; step: UpdateStep | null; label: string; percent: number }

function timingFile(): string { return join(getLaxDir(), "update-timing.json"); }

function usualMs(step: UpdateStep): number {
  if (step === "build") {
    try {
      const ms = (JSON.parse(readFileSync(timingFile(), "utf-8")) as { buildMs?: number }).buildMs;
      if (typeof ms === "number" && ms > 0) return ms;
    } catch { /* no build measured on this machine yet */ }
  }
  return STEPS.find((s) => s.step === step)!.usualMs;
}

/** Remembers how long this machine took to build an update, for the next bar. */
export function recordBuildDuration(ms: number): void {
  try { writeFileSync(timingFile(), JSON.stringify({ buildMs: Math.round(ms) })); } catch { /* the bar falls back to the default */ }
}

/** Share of the bar finished before step `index`. */
const before = (index: number): number => STEPS.slice(0, index).reduce((n, s) => n + s.share, 0);

function percentNow(r: Run, now: number): number {
  const s = STEPS[r.index];
  const within = Math.min(IN_STEP_CAP, (now - r.stepStartedAt) / usualMs(s.step));
  return before(r.index) + s.share * within;
}

export function beginUpdateProgress(mode: "preparing" | "installing", now = Date.now()): void {
  run = { mode, index: 0, stepStartedAt: now, percent: 0 };
}

/** The run moved on to `step`; steps it passed over (skipped) count as done. */
export function updateStep(step: UpdateStep, now = Date.now()): void {
  if (!run) return;
  const index = STEPS.findIndex((s) => s.step === step);
  if (index < run.index) return;
  run.percent = Math.max(run.percent, percentNow(run, now), before(index));
  run.index = index;
  run.stepStartedAt = now;
}

/** Whether an update is running (preparing or installing). */
export function updateProgressActive(): boolean {
  return run !== null;
}

/** A click joined a background preparation: the bar now reports an install. */
export function promoteToInstalling(): void {
  if (run) run.mode = "installing";
}

/** The run ended (prepared, installed, or failed): the bar goes away or shows ready. */
export function endUpdateProgress(): void {
  run = null;
}

export function updateProgress(isReady: boolean, now = Date.now()): UpdateProgress {
  if (!run) return { mode: isReady ? "ready" : "idle", step: null, label: isReady ? "Update ready to install" : "", percent: isReady ? 100 : 0 };
  run.percent = Math.min(100 - DONE_SHARE, Math.max(run.percent, percentNow(run, now)));
  const s = STEPS[run.index];
  return { mode: run.mode, step: s.step, label: s.label, percent: Math.round(run.percent) };
}
