import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type SyncConfig } from "../constants.js";
import { workspaceRoot } from "../../config.js";
import type { CronJob } from "../../cron/cron-service-types.js";
import { carriesForeignGrant, locallyGrantedAuthority, MISSION_GRANT_FIELDS } from "../../cron/job-authority.js";
import { createLogger } from "../../logger.js";
import { pullDir } from "../mirror.js";
import { applyTombstones, tombstonePaths } from "../tombstones.js";
import { sessionLogIsAhead } from "../session-log-ahead.js";
import { yieldEventLoop } from "../../util/time.js";
import { erasedSessions, isErasedCopy } from "../session-tombstones.js";

const logger = createLogger("sync.pull-files.misc");

// ── Which chats a pull has to compare ──
//
// Telling which copy of a chat is ahead reads both copies whole. A pull did
// that for every chat both this machine and the mirror hold: 3,648 chats and
// about a gigabyte read on one machine, 3 seconds of every server start with
// the event loop held (profiled 2026-11-24), to find that none had changed.
//
// The record (sync-state/pulled-sessions.json) holds, for each chat, the
// modified time and size of both copies when the mirror's was last found not
// ahead, or was copied here. While neither has changed, the answer has not
// either, and the pair is not read. It is this machine's own note: push keeps
// its counterpart beside it (push-sessions.ts), and neither travels.

/** [mirror mtime, mirror size, local mtime, local size] */
type CopyStamp = [number, number, number, number];

function comparedFile(dataDir: string): string {
  return join(dataDir, "sync-state", "pulled-sessions.json");
}

function readCompared(dataDir: string): Record<string, CopyStamp> {
  try {
    const parsed = JSON.parse(readFileSync(comparedFile(dataDir), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, CopyStamp> : {};
  } catch {
    // No record yet, or an unreadable one: every pair is compared by its contents.
    return {};
  }
}

function writeCompared(dataDir: string, record: Record<string, CopyStamp>): void {
  try {
    mkdirSync(join(dataDir, "sync-state"), { recursive: true });
    writeFileSync(comparedFile(dataDir), JSON.stringify(record), "utf-8");
  } catch (e) {
    // Without the record the next pull compares every pair again: slower, not wrong.
    logger.warn(`[sync] could not save the record of compared sessions: ${(e as Error).message}`);
  }
}

function stampOf(remote: string, local: string): CopyStamp {
  const r = statSync(remote);
  const l = statSync(local);
  return [r.mtimeMs, r.size, l.mtimeMs, l.size];
}

function sameStamp(a: CopyStamp | undefined, b: CopyStamp): boolean {
  return Array.isArray(a) && a.length === 4 && a.every((value, i) => value === b[i]);
}

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
 * A session this machine has archived is not resurrected, and a chat erased
 * on any machine is not copied back (session-tombstones.ts).
 */
export async function pullSessions(dataDir: string, syncDir: string, config: SyncConfig): Promise<string[]> {
  if (!config.syncSessions) return [];
  const syncSessDir = join(syncDir, "sessions");
  const sessDir = join(dataDir, "sessions");
  const archiveDir = join(dataDir, "sessions-archive");
  if (!existsSync(sessDir)) mkdirSync(sessDir, { recursive: true });
  if (!existsSync(syncSessDir)) return [];
  const pulled: string[] = [];
  const erased = erasedSessions(syncDir);
  const before = readCompared(dataDir);
  const after: Record<string, CopyStamp> = {};
  for (const f of readdirSync(syncSessDir)) {
    // Pull both .jsonl (current) and .json (legacy) so round-tripping
    // from an older machine still works; the SessionStore migration
    // on next boot converts any pulled .json to .jsonl.
    if (f.startsWith(".") || !(f.endsWith(".jsonl") || f.endsWith(".json"))) continue;
    if (existsSync(join(archiveDir, f))) continue;
    const local = join(sessDir, f);
    const remote = join(syncSessDir, f);
    const id = f.replace(/\.jsonl?$/, "");
    if (isErasedCopy(remote, id, erased)) continue;
    if (existsSync(local)) {
      const now = stampOf(remote, local);
      // Neither copy has changed since the mirror's was last found not ahead.
      if (sameStamp(before[f], now)) { after[f] = now; continue; }
      // Comparing contents reads both copies: the server gets a turn first.
      await yieldEventLoop();
      if (!sessionLogIsAhead(remote, local)) { after[f] = now; continue; }
    }
    writeFileSync(local, readFileSync(remote, "utf-8"));
    pulled.push(id);
    after[f] = stampOf(remote, local);
  }
  writeCompared(dataDir, after);
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
 * missions whose grants from the repo were left behind: a mission's own
 * autonomy profile lets its unattended runs act without asking, its signed-in
 * browser lets them browse as the user, and the agent can write the sync repo,
 * so a mission runs with the grants this computer gave the same mission, or
 * none (cron/job-authority.ts). Without them it runs under the user's own
 * profile, on its own browser profile.
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
        const granted = locallyGrantedAuthority(job, localById.get(job.id));
        if (carriesForeignGrant(job, granted)) dropped.push(job.name);
        for (const f of MISSION_GRANT_FIELDS) delete job[f];
        Object.assign(job, granted);
      }
      writeFileSync(localPath, JSON.stringify(jobs, null, 2));
    } catch (e) {
      logger.warn(`[sync] cron/jobs.json pull skipped: ${(e as Error).message}`);
    }
  }
  return dropped;
}
