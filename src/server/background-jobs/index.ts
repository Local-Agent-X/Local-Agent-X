import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SecurityLayer } from "../../security/index.js";
import type { LAXConfig, Session, ToolDefinition } from "../../types.js";
import type { SessionStore, MemoryIndex, MemoryManager } from "../../memory/index.js";
import type { SecretsStore } from "../../secrets.js";
import type { ToolPolicy } from "../../tool-policy.js";
import type { CronService } from "../../cron-service.js";
import type { IntegrationRegistry } from "../../integrations/index.js";
import type { AgentSync } from "../../sync/index.js";
import { JobScheduler } from "../scheduler.js";
import { createLogger } from "../../logger.js";
import { registerCronRunner } from "./cron-runner.js";
import { registerWorkerRunnerForServer } from "./worker-runner.js";
import { makeRunMemBg } from "./memory-bg.js";
import { makeRunDreamCheck } from "./dream-check.js";

const logger = createLogger("server.background-jobs");

export interface BackgroundJobsHandle {
  scheduler: JobScheduler;
}

export function startBackgroundJobs(deps: {
  config: LAXConfig;
  dataDir: string;
  sessionStore: SessionStore;
  memoryIndex: MemoryIndex;
  memoryManager: MemoryManager;
  secretsStore: SecretsStore;
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  cronService: CronService;
  integrations: IntegrationRegistry;
  agentSync: AgentSync;
  allAgentTools: ToolDefinition[];
  bridgeTools: ToolDefinition[];
  getOrCreateSession: (id: string) => Session;
  saveSession: (s: Session) => Promise<void>;
}): BackgroundJobsHandle {
  const {
    config, dataDir, sessionStore, memoryIndex, memoryManager, secretsStore, security, toolPolicy,
    cronService, integrations, agentSync, allAgentTools, bridgeTools,
    getOrCreateSession, saveSession,
  } = deps;

  const cronReportsDir = join(dataDir, "cron", "reports");
  if (!existsSync(cronReportsDir)) mkdirSync(cronReportsDir, { recursive: true });

  registerCronRunner({
    config, dataDir, memoryIndex, memoryManager, secretsStore, toolPolicy,
    cronService, integrations, allAgentTools, bridgeTools, cronReportsDir,
    getOrCreateSession, saveSession,
  });
  cronService.start();

  registerWorkerRunnerForServer({
    config, dataDir, secretsStore, security, toolPolicy, allAgentTools,
    getOrCreateSession, saveSession,
  });

  const scheduler = new JobScheduler();
  scheduler.register({
    name: "memory-bg",
    intervalMs: 6 * 60 * 60 * 1000,
    startupDelayMs: 30_000,
    run: makeRunMemBg({ dataDir, sessionStore, memoryIndex }),
  });
  scheduler.register({
    name: "idle-workers-cleanup",
    intervalMs: 10 * 60 * 1000,
    run: async () => {
      try {
        const { cleanupIdleWorkers } = await import("../../worker-session.js");
        const n = cleanupIdleWorkers();
        if (n > 0) logger.info(`[workers] Cleaned up ${n} idle worker sessions`);
      } catch { /* ignore */ }
    },
  });

  scheduler.register({
    name: "dream-check",
    intervalMs: 2 * 60 * 60 * 1000,
    startupDelayMs: 5 * 60 * 1000,
    run: makeRunDreamCheck({ config, dataDir, sessionStore, secretsStore, security, toolPolicy, allAgentTools, saveSession }),
  });

  scheduler.register({
    name: "protocol-curator",
    intervalMs: 6 * 60 * 60 * 1000, // poll every 6h; shouldCurate() gates actual work to ~daily
    startupDelayMs: 10 * 60 * 1000,
    run: async () => {
      try {
        const { shouldCurate, runCurator } = await import("../../protocols/curator.js");
        if (!shouldCurate()) return;
        const r = await runCurator();
        logger.info(`[curator] pass: archived=${r.transitions.archived.length} purged=${r.transitions.purged.length} clusters=${r.clusters.length} report=${r.reportPath}`);
      } catch (e) { logger.warn("[curator]", (e as Error).message); }
    },
  });

  setTimeout(async () => {
    try {
      const { getUniversalIndex } = await import("../../memory/universal-index.js");
      const ui = getUniversalIndex();
      if (!ui) return;
      const report = await ui.backfillAll();
      logger.info(`[memory-backfill] +${report.totalChunksAdded} chunks across ${report.totalFilesScanned} files (${report.durationMs}ms)`);
    } catch (e) { logger.warn("[memory-backfill] failed:", (e as Error).message); }
  }, 15_000);
  const syncCfg = agentSync.getConfig();
  if (syncCfg.enabled && syncCfg.autoDownload) agentSync.pull().then(r => { if (r.success) logger.info(`[sync] Startup pull: ${r.message}`); }).catch(() => {});
  agentSync.startHeartbeat();

  return { scheduler };
}
