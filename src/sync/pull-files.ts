import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createLogger } from "../logger.js";
import {
  BRAIN_BINARY_FILES,
  BRAIN_DIRS,
  BRAIN_JSON_FILES,
  MISSION_FILES,
  type SyncConfig,
} from "./constants.js";
import { pullDir, unionMerge } from "./mirror.js";
import { applyTombstones, tombstonePaths } from "./tombstones.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const logger = createLogger("sync.pull-files");

/**
 * Generic union-merge of two record arrays by a caller-supplied key, with
 * a caller-supplied collision predicate that decides whether local or
 * remote wins. Items with an empty / falsy key are skipped.
 *
 * Three callers today: id+updatedAt records (projects/issues/templates),
 * id+updated_at snake_case (tasks), name-keyed without a timestamp
 * (sidebar pins, custom missions, calendar events).
 */
export function unionMergeBy<T>(
  local: T[],
  remote: T[],
  keyOf: (item: T) => string,
  localWins: (l: T, r: T) => boolean,
): T[] {
  const byKey = new Map<string, T>();
  for (const r of remote) {
    const k = keyOf(r);
    if (k) byKey.set(k, r);
  }
  for (const l of local) {
    const k = keyOf(l);
    if (!k) continue;
    const r = byKey.get(k);
    if (!r || localWins(l, r)) byKey.set(k, l);
  }
  return Array.from(byKey.values());
}

/**
 * Union-merge by `id` with `updatedAt` tiebreak (camelCase). The original
 * helper, kept as a convenience wrapper because three call sites use it
 * (agent-projects.json, agent-issues.json, agent-templates.json).
 */
export function unionMergeRecordsById<T extends { id: string; updatedAt?: number }>(
  local: T[],
  remote: T[],
): T[] {
  return unionMergeBy(
    local,
    remote,
    (x) => x.id,
    (l, r) => (Number(l.updatedAt) || 0) > (Number(r.updatedAt) || 0),
  );
}

/**
 * Pull a JSON file that contains a record array with `{id, updatedAt}`
 * shape, union-merging local + remote rather than overwriting. Optional
 * tombstone filter runs AFTER the merge so deletes still propagate.
 *
 * Used by agent-projects.json, agent-issues.json, and agent-templates.json
 * — all three are user-data record arrays where a locally-newer entry
 * MUST survive a pull from a stale remote.
 */
function pullMergedRecordFile<T extends { id: string; updatedAt?: number }>(opts: {
  dataDir: string;
  syncDir: string;
  fileName: string;
  filterTombstoned?: (records: T[]) => T[];
}): void {
  const remotePath = join(opts.syncDir, opts.fileName);
  const localPath = join(opts.dataDir, opts.fileName);
  if (!existsSync(remotePath)) return;
  try {
    const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
    const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf-8")) : [];
    if (!Array.isArray(remote) || !Array.isArray(local)) return;
    let merged = unionMergeRecordsById<T>(local as T[], remote as T[]);
    if (opts.filterTombstoned) merged = opts.filterTombstoned(merged);
    writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf-8");
  } catch (e) {
    logger.warn(`[sync] ${opts.fileName} pull skipped: ${(e as Error).message}`);
  }
}

/** Files whose pull goes through an explicit merge block below, not the
 *  destructive overwrite loop. Keep in sync with the per-file blocks. */
const MERGED_BRAIN_FILES: ReadonlySet<string> = new Set([
  "agent-projects.json",
  "agent-issues.json",
  "agent-templates.json",
  "tasks.json",
  "calendar.json",
  "custom-missions.json",
  "mcp.json",
  "hooks.json",
]);

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

  // Sidebar pins: union-merge local + remote by name (local-wins on
  // collision since there's no timestamp, and the local copy reflects
  // the user's most recent unpin/rename on THIS machine). Then filter
  // through tombstones so a remote re-add of an unpinned item can't
  // resurrect it.
  //
  // Old behavior replaced local with (remote − tombstones), wiping any
  // pin the user added on this machine before it could be pushed. Same
  // family as the projects-on-pull data-loss bug.
  const syncPins = join(syncDir, "sidebar-pins.json");
  if (existsSync(syncPins)) {
    try {
      const remotePins = JSON.parse(readFileSync(syncPins, "utf-8"));
      if (Array.isArray(remotePins)) {
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
        const { pinTombstonePaths, listTombstonedPinNames, applyPinTombstones } = await import("./pin-tombstones.js");
        const tombstoned = listTombstonedPinNames(pinTombstonePaths(dataDir, syncDir));
        const filteredPins = applyPinTombstones(merged, tombstoned);
        if (filteredPins.length < merged.length) {
          logger.info(`[sync] pin tombstones filtered ${merged.length - filteredPins.length} pin(s)`);
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
  } else if (config.syncProtocols) {
    // Workspace sync OFF but syncProtocols ON: pull just the protocols
    // subtree so user-built and imported protocols flow across machines
    // without pulling apps/downloads/etc. Additive only.
    const syncProto = join(syncDir, "workspace", "protocols");
    if (existsSync(syncProto)) {
      const ws = resolve("workspace");
      const localProto = join(ws, "protocols");
      if (!existsSync(localProto)) mkdirSync(localProto, { recursive: true });
      pullDir(syncProto, localProto, /* additiveOnly */ true);
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

  // Brain backup — flat JSON files. Last-push-wins overwrite, EXCEPT for
  // files in MERGED_BRAIN_FILES (record-array shape with id+updatedAt) —
  // those go through pullMergedRecordFile below so locally-newer entries
  // survive a stale-remote pull. Don't delete a local-only file just
  // because it's missing from the remote (a fresh sync repo wouldn't
  // have these yet).
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

  // agent-projects.json: union-merge + project-tombstone filter.
  // Closes the Acme Springfield case (2026-05-22) where a locally-
  // created project was wiped by pull from a stale sync-repo.
  {
    const { projectTombstonePaths, listTombstonedProjectIds, applyProjectTombstones } = await import("./project-tombstones.js");
    const tombstoned = listTombstonedProjectIds(projectTombstonePaths(dataDir, syncDir));
    pullMergedRecordFile<{ id: string; updatedAt?: number }>({
      dataDir, syncDir, fileName: "agent-projects.json",
      filterTombstoned: (recs) => {
        const filtered = applyProjectTombstones(recs, tombstoned);
        const wiped = recs.length - filtered.length;
        if (wiped > 0) logger.info(`[sync] project tombstones filtered ${wiped} project(s)`);
        return filtered as typeof recs;
      },
    });
  }

  // agent-issues.json + agent-templates.json: same record-array shape,
  // same union-merge fix. Issues created or templates edited on this
  // machine that haven't been pushed yet now survive a stale pull. No
  // tombstone store for these today; if individual issues/templates
  // need delete-propagation later, add a tombstone source like
  // project-tombstones.ts.
  pullMergedRecordFile<{ id: string; updatedAt?: number }>({
    dataDir, syncDir, fileName: "agent-issues.json",
  });
  pullMergedRecordFile<{ id: string; updatedAt?: number }>({
    dataDir, syncDir, fileName: "agent-templates.json",
  });

  // tasks.json: array of {id, updated_at, ...}. Same merge semantic as
  // projects/issues/templates but with snake_case timestamp. Inlined
  // because the field name shift is too small to justify a separate
  // helper.
  {
    const remotePath = join(syncDir, "tasks.json");
    const localPath = join(dataDir, "tasks.json");
    if (existsSync(remotePath)) {
      try {
        const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
        const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf-8")) : [];
        if (Array.isArray(remote) && Array.isArray(local)) {
          const merged = unionMergeBy<{ id: string; updated_at?: number }>(
            local, remote,
            (x) => x.id,
            (l, r) => (Number(l.updated_at) || 0) > (Number(r.updated_at) || 0),
          );
          writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf-8");
        }
      } catch (e) {
        logger.warn(`[sync] tasks.json pull skipped: ${(e as Error).message}`);
      }
    }
  }

  // calendar.json: wrapped {events: [{id, ...}]}. No per-event
  // timestamp -- on collision, local wins (most-recently-edited on this
  // machine). Cross-machine convergence still happens because remote-
  // only events are added. Preserves any non-events top-level fields by
  // shallow-merging.
  {
    const remotePath = join(syncDir, "calendar.json");
    const localPath = join(dataDir, "calendar.json");
    if (existsSync(remotePath)) {
      try {
        const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
        const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf-8")) : { events: [] };
        const remoteEvents = Array.isArray(remote?.events) ? remote.events : [];
        const localEvents = Array.isArray(local?.events) ? local.events : [];
        const events = unionMergeBy<{ id: string }>(
          localEvents, remoteEvents,
          (x) => x.id,
          () => true,
        );
        const merged = { ...remote, ...local, events };
        writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf-8");
      } catch (e) {
        logger.warn(`[sync] calendar.json pull skipped: ${(e as Error).message}`);
      }
    }
  }

  // custom-missions.json: array of {name, ...}. Name-keyed, no timestamp.
  // On collision, local wins (a mission edited on this machine wins over
  // a stale remote copy with the same name).
  {
    const remotePath = join(syncDir, "custom-missions.json");
    const localPath = join(dataDir, "custom-missions.json");
    if (existsSync(remotePath)) {
      try {
        const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
        const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf-8")) : [];
        if (Array.isArray(remote) && Array.isArray(local)) {
          const merged = unionMergeBy<{ name: string }>(
            local, remote,
            (x) => x.name,
            () => true,
          );
          writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf-8");
        }
      } catch (e) {
        logger.warn(`[sync] custom-missions.json pull skipped: ${(e as Error).message}`);
      }
    }
  }

  // hooks.json: {hooks: [{name, event, command, ...}]}. Same shape as
  // custom-missions but wrapped. Name-keyed, no timestamp, local wins.
  {
    const remotePath = join(syncDir, "hooks.json");
    const localPath = join(dataDir, "hooks.json");
    if (existsSync(remotePath)) {
      try {
        const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
        const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf-8")) : { hooks: [] };
        const remoteHooks = Array.isArray(remote?.hooks) ? remote.hooks : [];
        const localHooks = Array.isArray(local?.hooks) ? local.hooks : [];
        const hooks = unionMergeBy<{ name: string }>(
          localHooks, remoteHooks,
          (x) => x.name,
          () => true,
        );
        const merged = { ...remote, ...local, hooks };
        writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf-8");
      } catch (e) {
        logger.warn(`[sync] hooks.json pull skipped: ${(e as Error).message}`);
      }
    }
  }

  // mcp.json: {servers: {<name>: {...}}}. Map of MCP server configs
  // keyed by server name. Spread-merge: union of server names, local
  // wins on collision (server config edited on this machine survives
  // a stale-remote pull). Path canonicalization runs on PUSH; expansion
  // back to ${HOME} happens at mcp-client load on the destination, so
  // sync just writes bytes here.
  {
    const remotePath = join(syncDir, "mcp.json");
    const localPath = join(dataDir, "mcp.json");
    if (existsSync(remotePath)) {
      try {
        const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
        const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf-8")) : {};
        const remoteServers = (remote && typeof remote === "object" && remote.servers && typeof remote.servers === "object") ? remote.servers : {};
        const localServers = (local && typeof local === "object" && local.servers && typeof local.servers === "object") ? local.servers : {};
        const servers = { ...remoteServers, ...localServers };
        const merged = { ...remote, ...local, servers };
        writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf-8");
      } catch (e) {
        logger.warn(`[sync] mcp.json pull skipped: ${(e as Error).message}`);
      }
    }
  }

  // Brain backup — directory trees. Destructive mirror so the
  // destination matches the remote tree exactly.
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
