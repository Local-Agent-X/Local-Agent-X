import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../../logger.js";
import {
  BRAIN_BINARY_FILES,
  BRAIN_DIRS,
  BRAIN_JSON_FILES,
  MISSION_FILES,
  type SyncConfig,
} from "../constants.js";
import { pullDir } from "../mirror.js";
import { MERGED_BRAIN_FILES } from "./merge-helpers.js";

const logger = createLogger("sync.pull-files.brain");

export function pullBrainJsonFiles(dataDir: string, syncDir: string, config: SyncConfig): void {
  // Brain backup — flat JSON files. Last-push-wins overwrite, EXCEPT for
  // files in MERGED_BRAIN_FILES (record-array shape with id+updatedAt) —
  // those go through pullMergedRecordFile in pull-merged-json.ts so
  // locally-newer entries survive a stale-remote pull. Don't delete a
  // local-only file just because it's missing from the remote (a fresh
  // sync repo wouldn't have these yet).
  for (const file of BRAIN_JSON_FILES) {
    if (MERGED_BRAIN_FILES.has(file)) continue;
    if (!config.syncMissions && MISSION_FILES.has(file)) continue;
    const remote = join(syncDir, file);
    if (!existsSync(remote)) continue;
    try {
      writeFileSync(join(dataDir, file), readFileSync(remote, "utf-8"), "utf-8");
    } catch (e) {
      logger.warn(`[sync] brain pull skipped ${file}: ${(e as Error).message}`);
    }
  }
}

export function pullBrainDirs(dataDir: string, syncDir: string): void {
  // Brain backup — directory trees.
  // Additive pull: locally-created run files (agent-runs/) and locally-
  // built dashboards (dashboards/) that haven't been pushed yet must
  // survive a stale-remote pull. Files are uniquely named per run id /
  // dashboard id, so there's no collision-on-create. Updates still flow
  // via the mtime-newer check inside pullDir. Deletes don't propagate
  // through this path -- if cross-machine delete becomes needed, layer
  // a tombstone source the way project-tombstones works.
  for (const dir of BRAIN_DIRS) {
    const remote = join(syncDir, dir);
    if (!existsSync(remote)) continue;
    const local = join(dataDir, dir);
    try {
      pullDir(remote, local, /* additiveOnly */ true);
    } catch (e) {
      logger.warn(`[sync] brain pull skipped dir ${dir}: ${(e as Error).message}`);
    }
  }
}

export function pullBrainBinaryFiles(dataDir: string, syncDir: string): void {
  // Brain backup — binary files (memory.db). Drop any stale
  // .db-wal / .db-shm sidecars before overwriting; SQLite recreates
  // them from the new .db on first read. Without this, a stale WAL
  // pointing at the previous .db can corrupt memory after restore.
  for (const file of BRAIN_BINARY_FILES) {
    const remote = join(syncDir, file);
    if (!existsSync(remote)) continue;
    const localPath = join(dataDir, file);
    try {
      for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
        const sidecarPath = join(dataDir, sidecar);
        if (existsSync(sidecarPath)) { try { unlinkSync(sidecarPath); } catch { /* swallow */ } }
      }
      writeFileSync(localPath, readFileSync(remote));
    } catch (e) {
      logger.warn(`[sync] brain pull skipped ${file}: ${(e as Error).message}`);
    }
  }
}
