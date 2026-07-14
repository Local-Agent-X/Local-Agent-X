import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SecurityLayer } from "../../security/index.js";
import type { LAXConfig, Session, ToolDefinition } from "../../types.js";
import type { SessionStore, MemoryIndex, MemoryManager } from "../../memory/index.js";
import type { SecretsStore } from "../../secrets.js";
import type { ToolPolicy } from "../../tool-policy/index.js";
import type { CronService } from "../../cron/cron-service.js";
import type { IntegrationRegistry } from "../../integrations/index.js";
import type { AgentSync } from "../../sync/index.js";
import { JobScheduler } from "../scheduler.js";
import { createLogger } from "../../logger.js";
import { registerCronRunner } from "./cron-runner.js";
import { registerWorkerRunnerForServer } from "./worker-runner.js";
import { registerSelfEditSurgeonForServer } from "./self-edit-surgeon-runner.js";
import { makeRunMemBg } from "./memory-bg.js";
import { registerDreamRunnerForServer } from "./dream-check.js";
import { isLocalOnlyMode, registerLocalOnlyTeardown } from "../../local-only-policy.js";

const logger = createLogger("server.background-jobs");

export interface BackgroundJobsHandle {
  scheduler: JobScheduler;
}

/** Idle threshold (ms) below which the LLM-heavy background lane is suppressed. */
export function readBgIdleThresholdMs(): number {
  const raw = parseInt(process.env.LAX_BG_IDLE_THRESHOLD_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 90_000;
}

/**
 * True when a user/agent/worker/cron turn wrote a session within `thresholdMs`.
 *
 * dream-check, the memory backfill, and the protocol curator all fire on
 * wall-clock timers, all hit the same provider key / rate-limit, and all lean
 * on the shared Ollama embedding CPU. Firing them mid-turn steals that budget
 * from the foreground. Every turn bumps its session's `updatedAt` on save, so
 * "a session was written within the threshold" is a sound foreground-busy
 * proxy — no new activity-tracking wiring required.
 */
export function isForegroundBusy(
  sessionStore: Pick<SessionStore, "list">,
  thresholdMs: number = readBgIdleThresholdMs(),
  now: number = Date.now(),
): boolean {
  const mostRecent = sessionStore.list().reduce((max, s) => Math.max(max, s.updatedAt), 0);
  return now - mostRecent < thresholdMs;
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

  // Foreground-idle gate shared by every LLM-heavy background job. See
  // isForegroundBusy() for why these must not contend with a live turn.
  const foregroundIdle = (): boolean => !isForegroundBusy(sessionStore);

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

  registerDreamRunnerForServer({
    config, dataDir, sessionStore, secretsStore, security, toolPolicy, allAgentTools, saveSession,
  });

  // Generic (in-loop) self_edit surgeon — last resort for providers with no
  // coding CLI. Builds its own per-worktree SecurityLayer, so no `security` dep.
  registerSelfEditSurgeonForServer({
    config, dataDir, secretsStore, toolPolicy, allAgentTools,
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
    name: "memory-write-canary",
    // Cheap (two local DB writes, no LLM) — run soon after boot so a broken
    // OTA update surfaces within minutes, then keep a steady heartbeat.
    intervalMs: 30 * 60 * 1000,
    startupDelayMs: 90_000,
    run: async () => {
      const { makeRunMemoryCanary } = await import("./memory-canary.js");
      const { broadcastAll } = await import("../../chat-ws/index.js");
      await makeRunMemoryCanary({ security, toolPolicy, allAgentTools, broadcast: broadcastAll })();
    },
  });

  scheduler.register({
    name: "dream-check",
    intervalMs: 2 * 60 * 60 * 1000,
    startupDelayMs: 5 * 60 * 1000,
    shouldRun: foregroundIdle,
    run: async () => {
      const { triggerDream } = await import("../../memory/dream.js");
      await triggerDream({ force: false }); // shouldDream() gates inside the runner
    },
  });

  scheduler.register({
    name: "protocol-curator",
    intervalMs: 6 * 60 * 60 * 1000, // poll every 6h; shouldCurate() gates actual work to ~daily
    startupDelayMs: 10 * 60 * 1000,
    shouldRun: foregroundIdle,
    run: async () => {
      try {
        const { shouldCurate, runCurator } = await import("../../protocols/curator.js");
        if (!shouldCurate()) return;
        const r = await runCurator();
        logger.info(`[curator] pass: archived=${r.transitions.archived.length} purged=${r.transitions.purged.length} clusters=${r.clusters.length} report=${r.reportPath}`);
      } catch (e) { logger.warn("[curator]", (e as Error).message); }
    },
  });

  const runBackfill = async () => {
    // Backfill scans every file and re-embeds via Ollama — defer past any live
    // turn so it doesn't fight the foreground for embedding CPU.
    if (isForegroundBusy(sessionStore)) { setTimeout(runBackfill, 30_000); return; }
    try {
      const { getUniversalIndex } = await import("../../memory/universal-index.js");
      const ui = getUniversalIndex();
      if (!ui) return;
      const report = await ui.backfillAll();
      logger.info(`[memory-backfill] +${report.totalChunksAdded} chunks across ${report.totalFilesScanned} files (${report.durationMs}ms)`);
    } catch (e) { logger.warn("[memory-backfill] failed:", (e as Error).message); }
  };
  setTimeout(runBackfill, 15_000);
  const syncCfg = agentSync.getConfig();
  if (!isLocalOnlyMode() && syncCfg.enabled && syncCfg.autoDownload) agentSync.pull().then(r => { if (r.success) logger.info(`[sync] Startup pull: ${r.message}`); }).catch(() => {});
  if (!isLocalOnlyMode()) agentSync.startHeartbeat();
  registerLocalOnlyTeardown("agent-sync", () => agentSync.stopHeartbeat());

  return { scheduler };
}
