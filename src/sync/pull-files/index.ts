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

export { unionMergeBy, unionMergeRecordsById } from "./merge-helpers.js";

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
}
