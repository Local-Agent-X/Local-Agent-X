import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../../logger.js";
import { unionMergeBy } from "./merge-helpers.js";

const logger = createLogger("sync.pull-files.pins");

/**
 * Sidebar pins: union-merge local + remote by name (local-wins on
 * collision since there's no timestamp, and the local copy reflects
 * the user's most recent unpin/rename on THIS machine). Then filter
 * through tombstones so a remote re-add of an unpinned item can't
 * resurrect it.
 *
 * Old behavior replaced local with (remote − tombstones), wiping any
 * pin the user added on this machine before it could be pushed. Same
 * family as the projects-on-pull data-loss bug.
 */
export async function pullSidebarPins(dataDir: string, syncDir: string): Promise<void> {
  const syncPins = join(syncDir, "sidebar-pins.json");
  if (!existsSync(syncPins)) return;
  try {
    const remotePins = JSON.parse(readFileSync(syncPins, "utf-8"));
    if (!Array.isArray(remotePins)) return;
    const localSettingsPath = join(dataDir, "settings.json");
    let localSettings: Record<string, unknown> = {};
    if (existsSync(localSettingsPath)) {
      try { localSettings = JSON.parse(readFileSync(localSettingsPath, "utf-8")); } catch { /* swallow */ }
    }
    const localPins = Array.isArray(localSettings.sidebarPins) ? localSettings.sidebarPins as Array<{ name: string }> : [];
    const merged = unionMergeBy<{ name: string }>(
      localPins, remotePins as Array<{ name: string }>,
      (x) => x.name,
      () => true,
    );
    const { pinTombstonePaths, listTombstonedPinNames, applyPinTombstones } = await import("../pin-tombstones.js");
    const tombstoned = listTombstonedPinNames(pinTombstonePaths(dataDir, syncDir));
    const filteredPins = applyPinTombstones(merged, tombstoned);
    if (filteredPins.length < merged.length) {
      logger.info(`[sync] pin tombstones filtered ${merged.length - filteredPins.length} pin(s)`);
    }
    localSettings.sidebarPins = filteredPins;
    writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2), "utf-8");
  } catch (e) {
    logger.warn(`[sync] sidebar-pins pull skipped: ${(e as Error).message}`);
  }
}
