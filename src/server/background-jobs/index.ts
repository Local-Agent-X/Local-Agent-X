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
import { JobScheduler, type OverlapPolicy } from "../scheduler.js";
import { createLogger } from "../../logger.js";
import { registerCronRunner } from "./cron-runner.js";
import { registerWorkerRunnerForServer } from "./worker-runner.js";
import { registerSelfEditSurgeonForServer } from "./self-edit-surgeon-runner.js";
import { makeRunMemBg } from "./memory-bg.js";
import { makeRunMemoryHygiene } from "./memory-hygiene.js";
import { registerDreamRunnerForServer } from "./dream-check.js";
import { registerSkillReviewRunner, runSkillReviewPass } from "./skill-review.js";
import { isLocalOnlyMode, registerLocalOnlyTeardown } from "../../local-only-policy.js";

const logger = createLogger("server.background-jobs");

export interface BackgroundJobsHandle {
  scheduler: JobScheduler;
}

/** Every job registered below. Adding one here is what forces its overlap
 *  policy to be declared in JOB_OVERLAP. */
export type RegisteredJobName =
  | "memory-bg"
  | "memory-hygiene"
  | "idle-workers-cleanup"
  | "memory-write-canary"
  | "dream-check"
  | "skill-review"
  | "protocol-curator";

/**
 * Overlap policy for every registered job, in one place. Not documentation —
 * each scheduler.register() call below spreads its policy out of this map (see
 * withOverlapPolicy), so the map IS the policy and cannot drift from it. Read
 * OverlapPolicy in ../scheduler.ts for what the two values mean.
 *
 * The distinction that matters: "skip" is right when the next tick is
 * EQUIVALENT to the one in flight; "self-guarded" is right when the repeated
 * tick IS the job's recovery mechanism. Six of these reconcile single-writer
 * state — one does not.
 *
 *   memory-bg (skip)
 *     MemoryOrchestrator.runBackground + algorithmic consolidate/reflect +
 *     bitemporal purge + session summarization + atlas warm — all single-writer
 *     on the same SQLite rows. Two passes race each other; a dropped tick costs
 *     nothing because the next 6h tick redoes exactly the same reconciliation.
 *
 *   memory-hygiene (skip)
 *     Embedding-cache LRU prune, PRAGMA optimize, a WAL TRUNCATE checkpoint
 *     under a deliberately lowered busy_timeout, and >90d session archival (a
 *     file move plus a memory.db repoint). A second concurrent pass is exactly
 *     what the lowered busy_timeout exists to avoid.
 *
 *   idle-workers-cleanup (skip)
 *     An idempotent sweep by idle age. A dropped tick costs at most 10 more
 *     minutes of a worker lingering.
 *
 *   memory-write-canary (skip)
 *     It PUBLISHES a health signal (two local writes + broadcastAll);
 *     overlapping canaries corrupt the very signal they report. Bounded by
 *     tool-timeout.ts anyway, so it always settles and can never wedge its slot.
 *
 *   dream-check (SELF-GUARDED)
 *     Its lock is the `dreaming` flag in dream-state.json, and shouldDream()
 *     force-releases one stuck past 30 minutes. That recovery is inside the
 *     runner, so it only runs when a later tick actually calls triggerDream() —
 *     and the dream's canonical run carries no timeout (a middleware suspend
 *     parks the op in a non-terminal `paused`). A scheduler latch over a hung
 *     dream would make the recovery unreachable and kill consolidation until
 *     the process restarts. The un-gated tick is cheap: while a dream is
 *     legitimately running, shouldDream() reads one small JSON and returns
 *     false, so nothing overlaps but a file read.
 *
 *   skill-review (skip)
 *     The QUEUE is the durable state and survives a dropped tick — no review is
 *     lost, only deferred by one 5-minute poll. Its own timeout + abort race
 *     guarantees a pass always settles, and its exported entry point claims
 *     this same latch primitive so the two call sites cannot drift.
 *
 *   protocol-curator (skip)
 *     runCurator() performs archive/purge lifecycle transitions that two
 *     concurrent passes would race. shouldCurate() gates work to ~daily but is
 *     a CADENCE gate, not a lock: it grants no exclusion and has no recovery
 *     deadline, so it cannot stand in for the latch the way dream's lock can.
 */
export const JOB_OVERLAP: Record<RegisteredJobName, OverlapPolicy> = {
  "memory-bg": "skip",
  "memory-hygiene": "skip",
  "idle-workers-cleanup": "skip",
  "memory-write-canary": "skip",
  "dream-check": "self-guarded",
  "skill-review": "skip",
  "protocol-curator": "skip",
};

/** Name + declared policy in one spread, so a registration can never carry a
 *  name whose policy was decided somewhere else. */
function withOverlapPolicy(name: RegisteredJobName): { name: RegisteredJobName; overlap: OverlapPolicy } {
  return { name, overlap: JOB_OVERLAP[name] };
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

  // Post-turn procedural learning. The turn-loop only ENQUEUES a review; the
  // scheduler below drains the queue, so no turn pays for its own review.
  registerSkillReviewRunner({
    config, dataDir, secretsStore, security, toolPolicy, allAgentTools,
  });

  // Generic (in-loop) self_edit surgeon — last resort for providers with no
  // coding CLI. Builds its own per-worktree SecurityLayer, so no `security` dep.
  registerSelfEditSurgeonForServer({
    config, dataDir, secretsStore, toolPolicy, allAgentTools,
  });

  const scheduler = new JobScheduler();
  scheduler.register({
    ...withOverlapPolicy("memory-bg"),
    intervalMs: 6 * 60 * 60 * 1000,
    startupDelayMs: 30_000,
    run: makeRunMemBg({ dataDir, sessionStore, memoryIndex }),
  });
  scheduler.register({
    ...withOverlapPolicy("memory-hygiene"),
    // Daily upkeep nothing else owns: embedding-cache LRU prune, WAL
    // truncation, PRAGMA optimize, and >90d session archival (move-only).
    intervalMs: 24 * 60 * 60 * 1000,
    startupDelayMs: 10 * 60 * 1000,
    shouldRun: foregroundIdle,
    run: makeRunMemoryHygiene({ dataDir, sessionStore, memoryIndex }),
  });
  scheduler.register({
    ...withOverlapPolicy("idle-workers-cleanup"),
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
    ...withOverlapPolicy("memory-write-canary"),
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
    ...withOverlapPolicy("dream-check"),
    intervalMs: 2 * 60 * 60 * 1000,
    startupDelayMs: 5 * 60 * 1000,
    shouldRun: foregroundIdle,
    run: async () => {
      const { triggerDream } = await import("../../memory/dream.js");
      // shouldDream() gates inside the runner — and force-releases a `dreaming`
      // flag stuck past 30min, which is why this job is registered
      // self-guarded: the recovery only happens if the tick reaches here.
      await triggerDream({ force: false });
    },
  });

  scheduler.register({
    ...withOverlapPolicy("skill-review"),
    // Poll often enough that a procedure is captured while the session is
    // still the user's current one; the queue is empty on most ticks, and
    // foregroundIdle keeps it off the provider key during a live turn.
    intervalMs: 5 * 60 * 1000,
    startupDelayMs: 3 * 60 * 1000,
    shouldRun: foregroundIdle,
    run: async () => {
      const r = await runSkillReviewPass();
      if (r.reviewed > 0 || r.failed > 0) {
        logger.info(`[skill-review] pass: reviewed=${r.reviewed} failed=${r.failed}`);
      }
    },
  });

  scheduler.register({
    ...withOverlapPolicy("protocol-curator"),
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
