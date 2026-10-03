import { existsSync } from "node:fs";
import { join } from "node:path";

import { CONTROL_FILES_NOT_SYNCED, type SyncConfig } from "../constants.js";
import { pullMemoryDir } from "./pull-memory.js";
import { pullSidebarPins } from "./pull-pins.js";
import { pullSessions, pullWorkspaceOrProtocols, pullCronJobs } from "./pull-misc.js";
import {
  pullAgentProjects,
  pullIssuesAndTemplates,
  pullTasks,
  pullCalendar,
  pullCustomMissions,
} from "./pull-merged-json.js";
import { pullBrainJsonFiles, pullBrainDirs, pullBrainBinaryFiles } from "./pull-brain.js";
import { importFactsFromSync } from "../facts-sync.js";
import { createLogger } from "../../logger.js";

export { unionMergeBy, unionMergeRecordsById } from "./merge-helpers.js";

const logger = createLogger("sync.pull-files");

// ── Pull direction: sync repo → local (with deletion propagation) ──

export interface PullReport {
  /** Session ids whose local log was created or extended by this pull. */
  pulledSessionIds: string[];
  /** Control files the sync repo holds that the pull left alone (CONTROL_FILES_NOT_SYNCED). */
  notSynced: string[];
  /** Missions that arrived without the autonomy profile the repo gave them (pullCronJobs). */
  missionProfilesDropped: string[];
}

export async function copyFromSync(dataDir: string, syncDir: string, config: SyncConfig): Promise<PullReport> {
  pullMemoryDir(dataDir, syncDir);
  await pullSidebarPins(dataDir, syncDir);
  const pulledSessionIds = pullSessions(dataDir, syncDir, config);
  pullWorkspaceOrProtocols(dataDir, syncDir, config);
  const missionProfilesDropped = pullCronJobs(dataDir, syncDir, config);
  pullBrainJsonFiles(dataDir, syncDir, config);
  await pullAgentProjects(dataDir, syncDir);
  pullIssuesAndTemplates(dataDir, syncDir);
  pullTasks(dataDir, syncDir);
  pullCalendar(dataDir, syncDir);
  pullCustomMissions(dataDir, syncDir);
  pullBrainDirs(dataDir, syncDir);
  pullBrainBinaryFiles(dataDir, syncDir);

  // Facts DB sync (cross-machine knowledge propagation). Runs LAST so any
  // memory.db restore from pullBrainBinaryFiles is in place first. Pulls
  // facts.jsonl and merges by (kind, content, entities) identity — local
  // facts not in remote are preserved; conflicts resolve by last_updated.
  try {
    const r = importFactsFromSync(dataDir, syncDir);
    if (r.inserted > 0 || r.updated > 0) {
      logger.info(`[sync] facts merged: ${r.inserted} inserted, ${r.updated} updated, ${r.skipped} skipped`);
    }
  } catch (e) {
    logger.warn(`[sync] facts import skipped: ${(e as Error).message}`);
  }
  const notSynced = CONTROL_FILES_NOT_SYNCED.filter((f) => existsSync(join(syncDir, f)));
  return { pulledSessionIds, notSynced, missionProfilesDropped };
}

/** What a pull left out on purpose, for the message the Sync settings show. */
export function pullReportNotes(report: PullReport): string {
  const notes: string[] = [];
  if (report.notSynced.length > 0) {
    notes.push(`Not synced: security files (${report.notSynced.join(", ")}). Set them up on this computer in Settings.`);
  }
  if (report.missionProfilesDropped.length > 0) {
    notes.push(`Missions that run under your own autonomy profile here, not the one they had elsewhere: ${report.missionProfilesDropped.join(", ")}. Give one its own profile on the Missions page.`);
  }
  return notes.map((n) => ` ${n}`).join("");
}
