import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type SyncConfig } from "../constants.js";
import { pullDir } from "../mirror.js";
import { applyTombstones, tombstonePaths } from "../tombstones.js";

export function pullSessions(dataDir: string, syncDir: string, config: SyncConfig): void {
  if (!config.syncSessions) return;
  const syncSessDir = join(syncDir, "sessions");
  const sessDir = join(dataDir, "sessions");
  if (!existsSync(sessDir)) mkdirSync(sessDir, { recursive: true });
  if (!existsSync(syncSessDir)) return;
  for (const f of readdirSync(syncSessDir)) {
    // Pull both .jsonl (current) and .json (legacy) so round-tripping
    // from an older machine still works; the SessionStore migration
    // on next boot converts any pulled .json to .jsonl.
    if ((f.endsWith(".jsonl") || f.endsWith(".json")) && !existsSync(join(sessDir, f))) {
      writeFileSync(join(sessDir, f), readFileSync(join(syncSessDir, f), "utf-8"));
    }
  }
}

export function pullWorkspaceOrProtocols(dataDir: string, syncDir: string, config: SyncConfig): void {
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
}

export function pullCronJobs(dataDir: string, syncDir: string, config: SyncConfig): void {
  if (!config.syncCronJobs) return;
  const syncCronDir = join(syncDir, "cron");
  const cronDir = join(dataDir, "cron");
  if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });
  if (!existsSync(syncCronDir)) return;
  for (const f of readdirSync(syncCronDir)) {
    if (f.endsWith(".json")) writeFileSync(join(cronDir, f), readFileSync(join(syncCronDir, f), "utf-8"));
  }
}
