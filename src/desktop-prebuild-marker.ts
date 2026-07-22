// Cross-boot marker for a failed desktop pre-build. The update pipeline
// pre-builds desktop/dist so a post-update restart is a single clean boot
// (update-pipeline.ts); when that build fails it used to be warn-only — if the
// next boot's reconcile then ALSO skipped the rebuild (deps degraded, hashes
// already baselined), the app silently ran the old desktop build for days.
// Recording the failure in ~/.lax/desktop-prebuild-pending.json lets the next
// desktop boot escalate loudly if dist is still stale.
//
// This is SERVER-side (ESM) code; the desktop-side reader lives in
// desktop/src/reconcile-hash.ts (CJS — the two sides cannot import each other,
// so they share the path by convention, pinned by
// test/desktop-reconcile-deps.test.ts). Reconcile clears the marker once dist
// is fresh again. All IO is best-effort: the marker must never decide an
// update's outcome or block anything.

import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./logger.js";

const logger = createLogger("update-pipeline");

export const DESKTOP_PREBUILD_MARKER_PATH = join(homedir(), ".lax", "desktop-prebuild-pending.json");

/** Log the desktop pre-build outcome and persist/clear the cross-boot marker.
 *  On success the marker is removed (a leftover one from an earlier failure is
 *  resolved); on failure it records when and why, for reconcile to surface. */
export function recordDesktopPrebuildOutcome(ok: boolean, detail: string, markerPath: string = DESKTOP_PREBUILD_MARKER_PATH): void {
  if (ok) {
    logger.info(`[update] pre-built desktop/dist for single-boot restart`);
    try { rmSync(markerPath, { force: true }); } catch { /* leftover marker just re-notifies */ }
    return;
  }
  logger.warn(`[update] desktop pre-build failed; reconcile will rebuild next boot: ${detail.slice(0, 300)}`);
  try {
    writeFileSync(markerPath, JSON.stringify({ failedAt: new Date().toISOString(), detail: detail.slice(0, 500) }, null, 2));
  } catch (e) {
    logger.warn(`[update] could not write desktop-prebuild marker: ${(e as Error).message}`);
  }
}
