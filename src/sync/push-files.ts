import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createLogger } from "../logger.js";
import {
  BRAIN_BINARY_FILES,
  BRAIN_DIRS,
  BRAIN_JSON_FILES,
  MISSION_FILES,
  type SyncConfig,
  canonicalizeHomePaths,
} from "./constants.js";
import { mirrorDir } from "./mirror.js";
import { tombstonePaths, writeTombstonesForDeletedApps } from "./tombstones.js";

const logger = createLogger("sync.push-files");

// ── Push direction: local → sync repo (with deletion propagation) ──

export function copyToSync(dataDir: string, syncDir: string, config: SyncConfig): void {
  const memDir = join(dataDir, "memory");
  const syncMemDir = join(syncDir, "memory");
  if (!existsSync(syncMemDir)) mkdirSync(syncMemDir, { recursive: true });

  // MIND.md is retired — facts moved to the indexed Facts DB
  // (see src/memory/tools/facts.ts). It must not propagate through sync:
  // union-merge would resurrect any old MIND.md content from another
  // machine, undoing the migration.
  const SYNC_SKIP_MEMORY_FILES = new Set(["MIND.md"]);

  const localMemFiles = new Set<string>();
  if (existsSync(memDir)) {
    for (const f of readdirSync(memDir)) {
      if (f.endsWith(".md") && !SYNC_SKIP_MEMORY_FILES.has(f)) {
        localMemFiles.add(f);
        writeFileSync(join(syncMemDir, f), readFileSync(join(memDir, f), "utf-8"), "utf-8");
      }
    }
  }
  // Delete from sync repo if deleted locally OR if it's a retired file.
  // Listing retired files here makes the deletion eventually-consistent —
  // first sync from any machine after this lands strips the file from
  // the shared repo, so subsequent pulls don't bring it back.
  for (const f of readdirSync(syncMemDir)) {
    if (f.endsWith(".md") && (!localMemFiles.has(f) || SYNC_SKIP_MEMORY_FILES.has(f))) {
      unlinkSync(join(syncMemDir, f));
    }
  }

  const policyPath = join(dataDir, "tool-policy.json");
  if (existsSync(policyPath)) writeFileSync(join(syncDir, "tool-policy.json"), readFileSync(policyPath, "utf-8"));

  // Sidebar pins (user-level UI state — per-user, not per-machine).
  // Extract just the `sidebarPins` key from settings.json and ship it
  // as its own file so machine-specific keys (port, voiceTier4Device,
  // etc.) don't ride along.
  const settingsPath = join(dataDir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const pins = Array.isArray(settings.sidebarPins) ? settings.sidebarPins : [];
      writeFileSync(join(syncDir, "sidebar-pins.json"), JSON.stringify(pins, null, 2));
    } catch (e) {
      logger.warn(`[sync] sidebar-pins push skipped: ${(e as Error).message}`);
    }
  }

  const configPath = join(dataDir, "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      delete cfg.authToken; delete cfg.openaiApiKey;
      writeFileSync(join(syncDir, "config-sanitized.json"), JSON.stringify(cfg, null, 2));
    } catch {}
  }

  if (config.syncSessions) {
    const sessDir = join(dataDir, "sessions");
    const syncSessDir = join(syncDir, "sessions");
    if (!existsSync(syncSessDir)) mkdirSync(syncSessDir, { recursive: true });
    if (existsSync(sessDir)) {
      for (const f of readdirSync(sessDir)) {
        // Sync both .jsonl (current) and .json (legacy/pre-migration) so
        // round-tripping a sync from an older machine still works.
        if (f.endsWith(".jsonl") || f.endsWith(".json")) writeFileSync(join(syncSessDir, f), readFileSync(join(sessDir, f), "utf-8"));
      }
    }
  }

  if (config.syncWorkspace) {
    const workspace = resolve("workspace");
    if (existsSync(workspace)) {
      // Workspace push uses tombstone-driven deletion (see
      // writeTombstonesForDeletedApps + applyTombstones). The mirror is
      // additive-only so local-only apps on other machines aren't
      // obliterated when this machine pushes.
      writeTombstonesForDeletedApps(tombstonePaths(dataDir, syncDir), syncDir);
      mirrorDir(workspace, join(syncDir, "workspace"), /* additiveOnly */ true);
    }
  } else if (config.syncProtocols) {
    // Workspace sync is OFF but the user still wants protocols to flow
    // between machines. Mirror just workspace/protocols/ as a subset so
    // protocols + imported SKILL.md packs propagate without dragging
    // apps/files/downloads along. Additive — never delete remote entries
    // from a partial-subset push.
    const protocolsDir = resolve("workspace", "protocols");
    if (existsSync(protocolsDir)) {
      const target = join(syncDir, "workspace", "protocols");
      if (!existsSync(target)) mkdirSync(target, { recursive: true });
      mirrorDir(protocolsDir, target, /* additiveOnly */ true);
    }
  }

  if (config.syncCronJobs) {
    const cronDir = join(dataDir, "cron");
    const syncCronDir = join(syncDir, "cron");
    if (!existsSync(syncCronDir)) mkdirSync(syncCronDir, { recursive: true });
    if (existsSync(cronDir)) {
      for (const f of readdirSync(cronDir)) {
        if (f.endsWith(".json")) writeFileSync(join(syncCronDir, f), readFileSync(join(cronDir, f), "utf-8"));
      }
    }
  }

  // Brain backup — flat JSON files. Last-push-wins. Skip if file
  // doesn't exist locally (means the user never created that surface).
  // mcp.json gets path canonicalization on push so per-machine literal
  // paths (C:/Users/manri/Documents) become portable ${HOME} placeholders
  // for every other machine that pulls.
  for (const file of BRAIN_JSON_FILES) {
    if (!config.syncMissions && MISSION_FILES.has(file)) continue;
    const src = join(dataDir, file);
    if (!existsSync(src)) continue;
    try {
      let content = readFileSync(src, "utf-8");
      if (file === "mcp.json") content = canonicalizeHomePaths(content);
      writeFileSync(join(syncDir, file), content, "utf-8");
    } catch (e) {
      logger.warn(`[sync] brain push skipped ${file}: ${(e as Error).message}`);
    }
  }

  // Brain backup — directory trees. Additive so a push from one
  // machine can't wipe sync-repo entries another machine pushed but
  // hasn't been pulled back here yet. Matches the additive pull on
  // the other side (sync/pull-files.ts) and the workspace push, which
  // has used additive for the same "don't delete other machines' work"
  // reason since the tombstone system landed.
  for (const dir of BRAIN_DIRS) {
    const src = join(dataDir, dir);
    if (!existsSync(src)) continue;
    try {
      mirrorDir(src, join(syncDir, dir), /* additiveOnly */ true);
    } catch (e) {
      logger.warn(`[sync] brain push skipped dir ${dir}: ${(e as Error).message}`);
    }
  }

  // Brain backup — binary files (currently memory.db). Copy the .db
  // alone; WAL/SHM sidecars are intentionally NOT shipped because
  // SQLite reconstructs them on first read and shipping stale
  // sidecars can corrupt the DB on the destination.
  for (const file of BRAIN_BINARY_FILES) {
    const src = join(dataDir, file);
    if (!existsSync(src)) continue;
    try {
      const data = readFileSync(src);
      if (data.length > 100 * 1024 * 1024) {
        logger.warn(`[sync] brain push skipped ${file}: size ${data.length} exceeds 100MB cap`);
        continue;
      }
      writeFileSync(join(syncDir, file), data);
    } catch (e) {
      logger.warn(`[sync] brain push skipped ${file}: ${(e as Error).message}`);
    }
  }
}
