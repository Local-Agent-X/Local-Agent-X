// Cross-boot marker for a failed desktop pre-build. The update pipeline
// pre-builds desktop/dist so a post-update restart is a single clean boot
// (update-pipeline.ts); when that build fails it used to be warn-only — if the
// next boot's reconcile then ALSO skipped the rebuild (deps degraded, hashes
// already baselined), the app silently ran the old desktop build for days.
// Recording the failure lets the next desktop boot escalate loudly if dist is
// still stale. The marker's path and shape are the desktop↔server contract
// (src/desktop-contract/prebuild-marker.ts); reconcile clears it once dist is
// fresh again.

import { createLogger } from "./logger.js";
import { prebuildMarkerPath } from "./desktop-contract/data-dir.js";
import { clearDesktopPrebuildMarker, writeDesktopPrebuildMarker } from "./desktop-contract/prebuild-marker.js";

const logger = createLogger("update-pipeline");

export const DESKTOP_PREBUILD_MARKER_PATH = prebuildMarkerPath();

/** Log the desktop pre-build outcome and persist/clear the cross-boot marker.
 *  On success the marker is removed (a leftover one from an earlier failure is
 *  resolved); on failure it records when and why, for reconcile to surface. */
export function recordDesktopPrebuildOutcome(ok: boolean, detail: string, markerPath: string = DESKTOP_PREBUILD_MARKER_PATH): void {
  if (ok) {
    logger.info(`[update] pre-built desktop/dist for single-boot restart`);
    clearDesktopPrebuildMarker(markerPath);
    return;
  }
  logger.warn(`[update] desktop pre-build failed; reconcile will rebuild next boot: ${detail.slice(0, 300)}`);
  try {
    writeDesktopPrebuildMarker(detail, markerPath);
  } catch (e) {
    logger.warn(`[update] could not write desktop-prebuild marker: ${(e as Error).message}`);
  }
}
