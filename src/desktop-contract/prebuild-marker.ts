// The cross-boot marker for a failed desktop pre-build. The server's update
// pipeline writes it when its post-update `desktop/dist` build failed, so the
// next desktop boot's reconcile escalates loudly if dist is still stale instead
// of running the old desktop build for days. Reconcile clears it once dist is
// fresh. All IO is best-effort: the marker never decides an update's outcome
// or blocks a boot.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { prebuildMarkerPath } from "./data-dir.js";

export interface DesktopPrebuildMarker { failedAt: string; detail: string }

export function writeDesktopPrebuildMarker(detail: string, markerPath: string = prebuildMarkerPath()): void {
  const marker: DesktopPrebuildMarker = { failedAt: new Date().toISOString(), detail: detail.slice(0, 500) };
  writeFileSync(markerPath, JSON.stringify(marker, null, 2));
}

export function readDesktopPrebuildMarker(markerPath: string = prebuildMarkerPath()): DesktopPrebuildMarker | null {
  if (!existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as Partial<DesktopPrebuildMarker> | null;
    if (parsed && typeof parsed.detail === "string" && typeof parsed.failedAt === "string") return parsed as DesktopPrebuildMarker;
  } catch { /* corrupt marker reads as absent — never blocks boot */ }
  return null;
}

export function clearDesktopPrebuildMarker(markerPath: string = prebuildMarkerPath()): void {
  try { rmSync(markerPath, { force: true }); } catch { /* leftover marker just re-notifies */ }
}
