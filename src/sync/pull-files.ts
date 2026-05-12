import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createLogger } from "../logger.js";
import {
  BRAIN_BINARY_FILES,
  BRAIN_DIRS,
  BRAIN_JSON_FILES,
  MISSION_FILES,
  PROTOCOL_FILES,
  PROTOCOL_DIRS,
  type SyncConfig,
} from "./constants.js";
import { pullDir, unionMerge } from "./mirror.js";
import { applyTombstones, tombstonePaths } from "./tombstones.js";

const logger = createLogger("sync.pull-files");

// ── Pull direction: sync repo → local (with deletion propagation) ──

export async function copyFromSync(dataDir: string, syncDir: string, config: SyncConfig): Promise<void> {
  const syncMemDir = join(syncDir, "memory");
  const memDir = join(dataDir, "memory");
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

  const remoteMemFiles = new Set<string>();
  if (existsSync(syncMemDir)) {
    let checkTaint: ((s: string) => { safe: boolean; reason?: string }) | null = null;
    try { checkTaint = require("../sanitize.js").checkMemoryTaint; } catch {}

    for (const f of readdirSync(syncMemDir)) {
      if (!f.endsWith(".md")) continue;
      remoteMemFiles.add(f);
      const syncContent = readFileSync(join(syncMemDir, f), "utf-8");
      if (checkTaint) {
        const t = checkTaint(syncContent);
        if (!t.safe) { logger.warn(`[sync] Rejected ${f}: ${t.reason}`); continue; }
      }
      const localPath = join(memDir, f);
      if (existsSync(localPath)) {
        writeFileSync(localPath, unionMerge(readFileSync(localPath, "utf-8"), syncContent), "utf-8");
      } else {
        writeFileSync(localPath, syncContent, "utf-8");
      }
    }
  }
  // Delete local memory files removed from sync repo
  for (const f of readdirSync(memDir)) {
    if (f.endsWith(".md") && !remoteMemFiles.has(f)) {
      logger.info(`[sync] Deleting ${f} (removed from remote)`);
      unlinkSync(join(memDir, f));
    }
  }

  // Tool policy: merge remote rules into local (don't overwrite — local may have new rules)
  const syncPolicy = join(syncDir, "tool-policy.json");
  if (existsSync(syncPolicy)) {
    try {
      const remote = JSON.parse(readFileSync(syncPolicy, "utf-8"));
      const localPath = join(dataDir, "tool-policy.json");
      if (existsSync(localPath)) {
        const local = JSON.parse(readFileSync(localPath, "utf-8"));
        const localIds = new Set((local.rules || []).map((r: any) => r.id));
        for (const rule of (remote.rules || [])) {
          if (!localIds.has(rule.id)) local.rules.push(rule);
        }
        writeFileSync(localPath, JSON.stringify(local, null, 2), "utf-8");
      } else {
        writeFileSync(localPath, readFileSync(syncPolicy, "utf-8"));
      }
    } catch { writeFileSync(join(dataDir, "tool-policy.json"), readFileSync(syncPolicy, "utf-8")); }
  }

  // Sidebar pins: replace the local sidebarPins array with the remote
  // one, MINUS anything tombstoned. Tombstones come from two stores:
  // the local per-machine "I unpinned this here" list, and the synced
  // store in sync-repo/.tombstones/pins/ where other machines record
  // their unpins. Without this filter, a remote that still has Mario
  // pinned would re-pin Mario on this machine every pull, undoing the
  // user's unpin.
  const syncPins = join(syncDir, "sidebar-pins.json");
  if (existsSync(syncPins)) {
    try {
      const remotePins = JSON.parse(readFileSync(syncPins, "utf-8"));
      if (Array.isArray(remotePins)) {
        const { pinTombstonePaths, listTombstonedPinNames, applyPinTombstones } = await import("./pin-tombstones.js");
        const tombstoned = listTombstonedPinNames(pinTombstonePaths(dataDir, syncDir));
        const filteredPins = applyPinTombstones(remotePins as Array<{ name: string }>, tombstoned);
        if (filteredPins.length < remotePins.length) {
          logger.info(`[sync] pin tombstones filtered ${remotePins.length - filteredPins.length} remote pin(s)`);
        }
        const localSettingsPath = join(dataDir, "settings.json");
        let localSettings: Record<string, unknown> = {};
        if (existsSync(localSettingsPath)) {
          try { localSettings = JSON.parse(readFileSync(localSettingsPath, "utf-8")); } catch { /* swallow */ }
        }
        localSettings.sidebarPins = filteredPins;
        writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2), "utf-8");
      }
    } catch (e) {
      logger.warn(`[sync] sidebar-pins pull skipped: ${(e as Error).message}`);
    }
  }

  if (config.syncSessions) {
    const syncSessDir = join(syncDir, "sessions");
    const sessDir = join(dataDir, "sessions");
    if (!existsSync(sessDir)) mkdirSync(sessDir, { recursive: true });
    if (existsSync(syncSessDir)) {
      for (const f of readdirSync(syncSessDir)) {
        // Pull both .jsonl (current) and .json (legacy) so round-tripping
        // from an older machine still works; the SessionStore migration
        // on next boot converts any pulled .json to .jsonl.
        if ((f.endsWith(".jsonl") || f.endsWith(".json")) && !existsSync(join(sessDir, f))) {
          writeFileSync(join(sessDir, f), readFileSync(join(syncSessDir, f), "utf-8"));
        }
      }
    }
  }

  if (config.syncWorkspace) {
    const syncWs = join(syncDir, "workspace");
    const ws = resolve("workspace");
    if (existsSync(syncWs)) {
      if (!existsSync(ws)) mkdirSync(ws, { recursive: true });
      // Workspace pull is additive-only — files only get copied IN, never
      // deleted by missing-from-remote. Deletions go through tombstones.
      pullDir(syncWs, ws, /* additiveOnly */ true);
      applyTombstones(tombstonePaths(dataDir, syncDir));
    }
  }

  if (config.syncCronJobs) {
    const syncCronDir = join(syncDir, "cron");
    const cronDir = join(dataDir, "cron");
    if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });
    if (existsSync(syncCronDir)) {
      for (const f of readdirSync(syncCronDir)) {
        if (f.endsWith(".json")) writeFileSync(join(cronDir, f), readFileSync(join(syncCronDir, f), "utf-8"));
      }
    }
  }

  // Brain backup — flat JSON files. Last-push-wins overwrite. Only
  // pull when the remote file exists; never delete a local-only
  // file just because it's missing from the remote (a fresh sync
  // repo wouldn't have these yet).
  for (const file of BRAIN_JSON_FILES) {
    if (!config.syncMissions && MISSION_FILES.has(file)) continue;
    if (!config.syncProtocols && PROTOCOL_FILES.has(file)) continue;
    const remote = join(syncDir, file);
    if (!existsSync(remote)) continue;
    try {
      writeFileSync(join(dataDir, file), readFileSync(remote, "utf-8"), "utf-8");
    } catch (e) {
      logger.warn(`[sync] brain pull skipped ${file}: ${(e as Error).message}`);
    }
  }

  // Brain backup — directory trees. Destructive mirror so the
  // destination matches the remote tree exactly.
  for (const dir of BRAIN_DIRS) {
    if (!config.syncProtocols && PROTOCOL_DIRS.has(dir)) continue;
    const remote = join(syncDir, dir);
    if (!existsSync(remote)) continue;
    const local = join(dataDir, dir);
    try {
      pullDir(remote, local, /* additiveOnly */ false);
    } catch (e) {
      logger.warn(`[sync] brain pull skipped dir ${dir}: ${(e as Error).message}`);
    }
  }

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
