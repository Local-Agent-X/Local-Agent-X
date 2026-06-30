import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../../logger.js";
import { reloadSettings, saveSettings } from "../../settings.js";
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
    // Fresh whole-object disk read via the canonical seam (preserves the
    // prior "see external writes" semantics); merge the new pins onto it and
    // save atomically so no sibling key is dropped.
    const localSettings = reloadSettings();
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
    saveSettings(localSettings);
  } catch (e) {
    logger.warn(`[sync] sidebar-pins pull skipped: ${(e as Error).message}`);
  }
}
