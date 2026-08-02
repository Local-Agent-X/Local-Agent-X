import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Local-only update-health tracking + self-repair. No telemetry, no network —
 * everything lives in <laxDir>/update-health.json and is surfaced in-app.
 *
 * Purpose: an update that fails silently and repeatedly is exactly how the
 * 2026-07 wedge stayed invisible until three machines were stuck. Here the app
 * NOTICES repeated failures and, past a small threshold, clears the transient
 * update state that a stuck update leaves behind (the rollback journal + any
 * half-downloaded tarball) so the NEXT attempt starts clean — turning "stuck
 * forever" into "self-recovers on the next try", and making the failure visible
 * either way.
 *
 * Deliberately NOT an auto-retry loop: it repairs state and reports, the retry
 * is still user/next-cycle initiated, so a genuinely broken release can't spin.
 */
export interface UpdateHealth {
  consecutiveFailures: number;
  lastError?: string;
  repairAttempted: boolean;
}

const HEALTH_FILE = "update-health.json";
const clean: UpdateHealth = { consecutiveFailures: 0, repairAttempted: false };

/** Number of consecutive failures after which we clear stale update state. */
export const REPAIR_THRESHOLD = 2;

export function readUpdateHealth(laxDir: string): UpdateHealth {
  try {
    const value = JSON.parse(readFileSync(join(laxDir, HEALTH_FILE), "utf-8")) as Partial<UpdateHealth>;
    return {
      consecutiveFailures: Number.isInteger(value.consecutiveFailures) ? Math.max(0, value.consecutiveFailures as number) : 0,
      lastError: typeof value.lastError === "string" ? value.lastError : undefined,
      repairAttempted: value.repairAttempted === true,
    };
  } catch {
    return { ...clean };
  }
}

function write(laxDir: string, health: UpdateHealth): void {
  try { writeFileSync(join(laxDir, HEALTH_FILE), JSON.stringify(health), { encoding: "utf-8" }); }
  catch { /* health tracking is best-effort; never let it break an update */ }
}

/** Clear the counter after any successful update (or "already up to date"). */
export function recordUpdateSuccess(laxDir: string): void {
  write(laxDir, { ...clean });
}

/** Record a failure and return the updated health (caller decides on repair). */
export function recordUpdateFailure(laxDir: string, detail: string): UpdateHealth {
  const prev = readUpdateHealth(laxDir);
  const next: UpdateHealth = {
    consecutiveFailures: prev.consecutiveFailures + 1,
    lastError: detail.slice(0, 300),
    repairAttempted: prev.repairAttempted,
  };
  write(laxDir, next);
  return next;
}

/**
 * Remove the transient state a stuck update leaves behind — the rollback
 * transaction directory (the 2026-07 wedge source) and any partially-downloaded
 * update payload. Only ever touches those two laxDir-scoped subpaths; never the
 * config, history, or installed-source records. Returns what it cleared. Never
 * throws. Safe to call only when updates are already failing (nothing in flight
 * is worth preserving once attempts are consistently failing).
 */
export function repairStuckUpdateState(laxDir: string): string[] {
  const cleared: string[] = [];
  for (const rel of ["update-rollback", "updates"]) {
    try {
      const target = join(laxDir, rel);
      if (existsSync(target)) { rmSync(target, { recursive: true, force: true }); cleared.push(rel); }
    } catch { /* best-effort */ }
  }
  return cleared;
}

/** Mark that repair has been attempted for the current failure streak (so it
 *  runs once per streak, not every failure). */
export function markRepairAttempted(laxDir: string): void {
  write(laxDir, { ...readUpdateHealth(laxDir), repairAttempted: true });
}
