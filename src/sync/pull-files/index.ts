import { type SyncConfig } from "../constants.js";
import { pullMemoryDir, pullToolPolicy } from "./pull-memory.js";
import { pullSidebarPins } from "./pull-pins.js";
import { pullSessions, pullWorkspaceOrProtocols, pullCronJobs } from "./pull-misc.js";
import {
  pullAgentProjects,
  pullIssuesAndTemplates,
  pullTasks,
  pullCalendar,
  pullCustomMissions,
  pullHooks,
  pullMcp,
} from "./pull-merged-json.js";
import { pullBrainJsonFiles, pullBrainDirs, pullBrainBinaryFiles } from "./pull-brain.js";
import { importFactsFromSync } from "../facts-sync.js";
import { createLogger } from "../../logger.js";

export { unionMergeBy, unionMergeRecordsById } from "./merge-helpers.js";

const logger = createLogger("sync.pull-files");

// ── Pull direction: sync repo → local (with deletion propagation) ──

export async function copyFromSync(dataDir: string, syncDir: string, config: SyncConfig): Promise<void> {
  pullMemoryDir(dataDir, syncDir);
  pullToolPolicy(dataDir, syncDir);
  await pullSidebarPins(dataDir, syncDir);
  pullSessions(dataDir, syncDir, config);
  pullWorkspaceOrProtocols(dataDir, syncDir, config);
  pullCronJobs(dataDir, syncDir, config);
  pullBrainJsonFiles(dataDir, syncDir, config);
  await pullAgentProjects(dataDir, syncDir);
  pullIssuesAndTemplates(dataDir, syncDir);
  pullTasks(dataDir, syncDir);
  pullCalendar(dataDir, syncDir);
  pullCustomMissions(dataDir, syncDir);
  pullHooks(dataDir, syncDir);
  pullMcp(dataDir, syncDir);
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
}
