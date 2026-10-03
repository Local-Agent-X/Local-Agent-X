import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type SyncConfig } from "../constants.js";
import { workspaceRoot } from "../../config.js";
import type { CronJob } from "../../cron/cron-service-types.js";
import { locallyGrantedProfile } from "../../cron/job-authority.js";
import { createLogger } from "../../logger.js";
import { pullDir } from "../mirror.js";
import { applyTombstones, tombstonePaths } from "../tombstones.js";

const logger = createLogger("sync.pull-files.misc");

/**
 * Copy sessions from the mirror. Returns the ids whose local file changed, so
 * the caller can index and adopt them.
 *
 * A session log is append-only and authored on one machine, so a remote copy
 * that is LARGER than the local one carries turns the local one lacks. The
 * earlier rule copied only missing files: a session pulled once was frozen at
 * that moment, every later turn on the other machine never arrived, and this
 * machine's push then wrote the stale copy back over the mirror's fresh one.
 * The `.metadata.*` dotfiles are this machine's own cache and never travel.
 * A session this machine has archived is not resurrected.
 */
export function pullSessions(dataDir: string, syncDir: string, config: SyncConfig): string[] {
  if (!config.syncSessions) return [];
  const syncSessDir = join(syncDir, "sessions");
  const sessDir = join(dataDir, "sessions");
  const archiveDir = join(dataDir, "sessions-archive");
  if (!existsSync(sessDir)) mkdirSync(sessDir, { recursive: true });
  if (!existsSync(syncSessDir)) return [];
  const pulled: string[] = [];
  for (const f of readdirSync(syncSessDir)) {
    // Pull both .jsonl (current) and .json (legacy) so round-tripping
    // from an older machine still works; the SessionStore migration
    // on next boot converts any pulled .json to .jsonl.
    if (f.startsWith(".") || !(f.endsWith(".jsonl") || f.endsWith(".json"))) continue;
    if (existsSync(join(archiveDir, f))) continue;
    const local = join(sessDir, f);
    const remote = join(syncSessDir, f);
    if (existsSync(local) && statSync(local).size >= statSync(remote).size) continue;
    writeFileSync(local, readFileSync(remote, "utf-8"));
    pulled.push(f.replace(/\.jsonl?$/, ""));
  }
  return pulled;
}

export function pullWorkspaceOrProtocols(dataDir: string, syncDir: string, config: SyncConfig): void {
  if (config.syncWorkspace) {
    const syncWs = join(syncDir, "workspace");
    const ws = workspaceRoot();
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
      const ws = workspaceRoot();
      const localProto = join(ws, "protocols");
      if (!existsSync(localProto)) mkdirSync(localProto, { recursive: true });
      pullDir(syncProto, localProto, /* additiveOnly */ true);
    }
  }
}

/**
 * Copy the missions and their settings from the mirror. Returns the names of
 * missions whose autonomy profile from the repo was left behind: a mission's
 * own profile lets its unattended runs act without asking, and the agent can
 * write the sync repo, so a mission runs with the profile this computer
 * granted the same mission, or none (cron/job-authority.ts). Without one it
 * runs under the user's own profile.
 */
export function pullCronJobs(dataDir: string, syncDir: string, config: SyncConfig): string[] {
  if (!config.syncCronJobs) return [];
  const syncCronDir = join(syncDir, "cron");
  const cronDir = join(dataDir, "cron");
  if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });
  if (!existsSync(syncCronDir)) return [];
  const dropped: string[] = [];
  for (const f of readdirSync(syncCronDir)) {
    if (!f.endsWith(".json")) continue;
    const remote = readFileSync(join(syncCronDir, f), "utf-8");
    // CronService keeps its missions, an array of CronJob, in jobs.json.
    if (f !== "jobs.json") { writeFileSync(join(cronDir, f), remote); continue; }
    try {
      const jobs = JSON.parse(remote) as CronJob[];
      const localPath = join(cronDir, f);
      const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf-8")) as CronJob[] : [];
      const localById = new Map(local.map((j) => [j.id, j]));
      for (const job of jobs) {
        const granted = locallyGrantedProfile(job, localById.get(job.id));
        if (job.profile !== undefined && job.profile !== granted) dropped.push(job.name);
        if (granted === undefined) delete job.profile;
        else job.profile = granted;
      }
      writeFileSync(localPath, JSON.stringify(jobs, null, 2));
    } catch (e) {
      logger.warn(`[sync] cron/jobs.json pull skipped: ${(e as Error).message}`);
    }
  }
  return dropped;
}
