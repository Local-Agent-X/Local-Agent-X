import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { runAgent, type AgentOptions } from "../agent.js";
import { stripEphemeralMessages } from "../agent-providers.js";
import { extractAgentOutput } from "../server-utils.js";
import { SecurityLayer } from "../security.js";
import type { LAXConfig, Session, ToolDefinition } from "../types.js";
import type { SessionStore, MemoryIndex, MemoryManager } from "../memory.js";
import type { SecretsStore } from "../secrets.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { CronService } from "../cron-service.js";
import type { IntegrationRegistry } from "../integrations.js";
import type { AgentSync } from "../sync.js";
import { JobScheduler } from "./scheduler.js";

import { createLogger } from "../logger.js";
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
  saveSession: (s: Session) => void;
}): BackgroundJobsHandle {
  const {
    config, dataDir, sessionStore, memoryIndex, memoryManager, secretsStore, security, toolPolicy,
    cronService, integrations, agentSync, allAgentTools, bridgeTools,
    getOrCreateSession, saveSession,
  } = deps;

  const cronReportsDir = join(dataDir, "cron", "reports");
  if (!existsSync(cronReportsDir)) mkdirSync(cronReportsDir, { recursive: true });
  cronService.onExecute(async (jobId, prompt) => {
    const cronSecurity = new SecurityLayer(resolve(process.env.LAX_WORKSPACE ?? process.env.SAX_WORKSPACE ?? join(homedir(), ".lax", "workspace")), "workspace");
    const sessionId = `cron-${jobId}-${Date.now()}`;
    try {
      const { Handler } = await import("../agency/handler.js");
      Handler.getInstance().currentSessionId = sessionId;
    } catch {}
    const { prepareAgentRequest } = await import("../agent-request.js");
    const prepared = await prepareAgentRequest({
      channel: "cron", message: prompt, sessionMessages: [], sessionId,
      config, dataDir, memoryIndex, memoryManager, integrations, secretsStore,
      allAgentTools, bridgeTools, skipMemory: true,
    });
    const cronModel = prepared.provider === "anthropic" ? "claude-haiku-4-5" : prepared.model;
    const cronSystemPrompt = `You are a focused task execution agent. Your ONLY job is to complete the task described below. Do not list protocols, do not search memories unless the task requires it, do not do anything other than what is asked. Use the tools available to complete the task thoroughly and return the results.\n\nTask:\n${prompt}`;
    const result = await runAgent(prompt, [], { apiKey: prepared.apiKey, model: cronModel, provider: prepared.provider as AgentOptions["provider"], systemPrompt: cronSystemPrompt, tools: prepared.tools, security: cronSecurity, toolPolicy, sessionId, maxIterations: config.maxIterations });
    const session = getOrCreateSession(sessionId);
    session.messages = stripEphemeralMessages(result.messages).filter(m => m.role !== "system"); session.updatedAt = Date.now(); saveSession(session);
    let output = extractAgentOutput(result.messages);
    try {
      const { Handler } = await import("../agency/handler.js");
      const handler = Handler.getInstance();
      const subResults = await handler.waitForSessionAgents(sessionId, 300_000);
      if (subResults.length > 0) {
        const subOutput = subResults.join("\n\n---\n\n");
        output = subOutput.length > output.length ? subOutput : output + "\n\n---\n\n" + subOutput;
        logger.info(`[cron] Job ${jobId}: collected ${subResults.length} sub-agent result(s)`);
      }
    } catch (e) { logger.warn(`[cron] Sub-agent wait error:`, (e as Error).message); }
    if (!output) {
      logger.error(`[cron] Job ${jobId} produced no output (stopReason: ${result.stopReason})`);
      return { output: "ERROR: Agent produced no output — check provider/model config" };
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const jobDir = join(cronReportsDir, jobId);
    if (!existsSync(jobDir)) mkdirSync(jobDir, { recursive: true });
    const reportPath = join(jobDir, `${ts}.md`);
    const job = cronService.get(jobId);
    const reportContent = `# ${job?.name || jobId} — ${new Date().toLocaleDateString()}\n\n${output}`;
    writeFileSync(reportPath, reportContent, "utf-8");
    const slug = (job?.name || jobId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    const missionDir = join(resolve(config.workspace), "missions", slug);
    mkdirSync(missionDir, { recursive: true });
    const wsCopy = join(missionDir, `${ts}.md`);
    writeFileSync(wsCopy, reportContent, "utf-8");
    writeFileSync(join(missionDir, "latest.md"), reportContent, "utf-8");
    logger.info(`[cron] Report saved: ${reportPath} + ${wsCopy}`);
    return { output: output.slice(0, 500), reportPath };
  });
  cronService.start();

  import("../worker-session.js").then(({ registerWorkerRunner }) => {
    registerWorkerRunner(async (workerSession, message) => {
      const { resolveProvider } = await import("../agent-request.js");
      const sessionId = workerSession.id;
      const { provider, apiKey, model } = await resolveProvider(config, secretsStore, dataDir);

      const workerPrompt = `You are a focused app builder. Your working directory is: ${workerSession.workingDir}

Your job: build or edit the app as instructed. Write complete, working code.

Rules:
- Use the write tool to create new files (use absolute paths in ${workerSession.workingDir}/)
- Use edit for targeted changes to existing files
- The main entry point MUST be index.html
- For single-page apps: inline CSS and JS in index.html is fine
- Make it polished — modern CSS, good colors, responsive design
- If using images from the web, use full URLs (https://)
- Do NOT ask questions — just build it
- When done, confirm what you created/changed`;
      const workerTools = allAgentTools.filter(t =>
        ["read", "write", "edit", "bash", "glob", "grep", "web_fetch", "web_search", "view_image"].includes(t.name)
      );
      const session = getOrCreateSession(sessionId);
      const hasExistingApp = existsSync(join(workerSession.workingDir, "index.html"));
      const history = hasExistingApp ? session.messages.slice(-10) : [];
      const result = await runAgent(message, history, {
        apiKey, model,
        provider: provider as AgentOptions["provider"],
        systemPrompt: workerPrompt, tools: workerTools,
        security, toolPolicy, sessionId,
        maxIterations: 15,
      });
      session.messages = stripEphemeralMessages(result.messages).filter(m => m.role !== "system");
      session.updatedAt = Date.now(); saveSession(session);
      return extractAgentOutput(result.messages);
    });
    logger.info("[workers] Runner registered");
  }).catch(() => {});

  const runMemBg = async () => {
    try { const { MemoryOrchestrator: MO } = await import("../memory-orchestrator.js"); const r = MO.getInstance().runBackground(memoryIndex); logger.info(`[memory-bg] ${r.totalTimeMs}ms`); } catch (e) { logger.warn("[memory-bg]", (e as Error).message); }
    try {
      let totalRetained = 0;
      for (let i = 0; i < 3; i++) {
        const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const facts = memoryIndex.retainFromDailyLog(date);
        totalRetained += facts.length;
      }
      if (totalRetained > 0) logger.info(`[memory-bg] Retained ${totalRetained} facts from daily logs`);
    } catch (e) { logger.warn("[memory-bg] Retain:", (e as Error).message); }
    try {
      const reflectResult = await memoryIndex.reflect(7);
      if (reflectResult.entitiesUpdated.length > 0 || reflectResult.opinionsUpdated > 0) {
        logger.info(`[memory-bg] Reflect: ${reflectResult.entitiesUpdated.length} entities, ${reflectResult.opinionsUpdated} opinions`);
      }
    } catch (e) { logger.warn("[memory-bg] Reflect:", (e as Error).message); }
    try {
      const { MemoryConsolidator: MC } = await import("../memory-consolidation.js");
      const report = MC.getInstance().consolidate();
      if (report.mergedCount > 0 || report.promotedCount > 0) {
        logger.info(`[memory-bg] Consolidation: merged=${report.mergedCount} promoted=${report.promotedCount} entities=${report.entityPagesUpdated}`);
      }
    } catch (e) { logger.warn("[memory-bg] Consolidation:", (e as Error).message); }
    try {
      const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000, recent = sessionStore.list().filter(s => s.updatedAt > cutoff && s.messageCount > 2);
      const dir = join(dataDir, "memory", "session-summaries"); mkdirSync(dir, { recursive: true }); let n = 0;
      const newlySummarized: string[] = [];
      for (const meta of recent.slice(0, 30)) {
        const sf = join(dir, `${meta.id}.md`);
        if (existsSync(sf)) continue;
        const sess = sessionStore.load(meta.id);
        if (!sess) continue;
        const userMsgs = sess.messages.filter(m => m.role === "user" && typeof m.content === "string").map(m => (m.content as string).slice(0, 200));
        const agentMsgs = sess.messages.filter(m => m.role === "assistant" && typeof m.content === "string").map(m => (m.content as string).split("\n").filter(l => l.trim())[0]?.slice(0, 200) || "");
        const summary = `# ${sess.title}\n\nDate: ${new Date(sess.createdAt).toISOString().split("T")[0]}\nMessages: ${sess.messages.length}\n\n## Key Exchanges\n${userMsgs.slice(0, 10).map((u, i) => `- User: ${u}\n  Agent: ${agentMsgs[i] || "..."}`).join("\n")}\n`;
        writeFileSync(sf, summary, "utf-8");
        n++;
        newlySummarized.push(meta.id);
      }
      if (n > 0) logger.info(`[memory-bg] Summarized ${n} sessions`);
      if (newlySummarized.length > 0) {
        try {
          const { getUniversalIndex } = await import("../memory/universal-index.js");
          const ui = getUniversalIndex();
          if (ui) for (const id of newlySummarized) await ui.indexSessionSummary(id);
        } catch (e) { logger.warn("[memory-bg] Summary reindex:", (e as Error).message); }
      }
    } catch (e) { logger.warn("[memory-bg] Summarization:", (e as Error).message); }
  };
  const scheduler = new JobScheduler();
  scheduler.register({
    name: "memory-bg",
    intervalMs: 6 * 60 * 60 * 1000,
    startupDelayMs: 30_000,
    run: runMemBg,
  });
  scheduler.register({
    name: "idle-workers-cleanup",
    intervalMs: 10 * 60 * 1000,
    run: async () => {
      try {
        const { cleanupIdleWorkers } = await import("../worker-session.js");
        const n = cleanupIdleWorkers();
        if (n > 0) logger.info(`[workers] Cleaned up ${n} idle worker sessions`);
      } catch { /* ignore */ }
    },
  });

  // One-shot startup: scrub stale transcript lines from MIND.md. The 6h
  // memory-bg cycle handles ongoing consolidation, so no separate nightly
  // schedule is needed.
  import("../memory-consolidation.js").then(({ MemoryConsolidator: MC }) => {
    try {
      const scrub = MC.getInstance().scrubMindFile();
      if (scrub.linesRemoved > 0) {
        logger.info(`[memory] Scrubbed ${scrub.linesRemoved} transcript lines from MIND.md (${scrub.linesKept} strategic lines kept)`);
      }
    } catch (e) { logger.warn("[memory] MIND.md scrub failed:", (e as Error).message); }
  }).catch(e => logger.warn("[memory] MIND.md scrub init failed:", (e as Error).message));

  const runDreamCheck = async () => {
    try {
      const {
        shouldDream, buildDreamPrompt, buildDreamPromptForBatch,
        listRecentSessionTranscripts, buildDreamBatches,
        startDream, completeDream,
      } = await import("../memory-dream.js");
      if (!shouldDream()) return;
      logger.info("[dream] Starting memory consolidation...");
      startDream();
      const { resolveProvider: rp } = await import("../agent-request.js");
      const { provider, apiKey, model } = await rp(config, secretsStore, dataDir);
      const dreamModel = provider === "anthropic" ? "claude-haiku-4-5" : model;
      const dreamSession: Session = { id: `dream-${Date.now()}`, title: "Memory Dream", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      const dreamTools = allAgentTools.filter(t => ["read", "write", "edit", "glob", "grep", "memory_search", "memory_save"].includes(t.name));
      const sysPrompt = "You are a memory consolidation agent. Your job is to organize and improve the user's memory files based on recent sessions. Be concise and focused.";

      const transcripts = listRecentSessionTranscripts(10);
      const batches = transcripts.length > 0 ? buildDreamBatches(transcripts) : [];

      if (batches.length === 0) {
        const result = await runAgent(buildDreamPrompt(), [], {
          apiKey, model: dreamModel, provider: provider as AgentOptions["provider"],
          systemPrompt: sysPrompt, tools: dreamTools, security, toolPolicy,
          sessionId: dreamSession.id, maxIterations: 10, temperature: 0.3,
        });
        dreamSession.messages.push(...result.messages.filter(m => m.role !== "system"));
      } else {
        for (let i = 0; i < batches.length; i++) {
          const prompt = buildDreamPromptForBatch(batches[i], i, batches.length);
          const result = await runAgent(prompt, [], {
            apiKey, model: dreamModel, provider: provider as AgentOptions["provider"],
            systemPrompt: sysPrompt, tools: dreamTools, security, toolPolicy,
            sessionId: `${dreamSession.id}-b${i}`, maxIterations: 15, temperature: 0.3,
          });
          dreamSession.messages.push(...result.messages.filter(m => m.role !== "system"));
        }
      }

      dreamSession.updatedAt = Date.now();
      saveSession(dreamSession);

      try {
        const { getUniversalIndex } = await import("../memory/universal-index.js");
        const ui = getUniversalIndex();
        if (ui) {
          const report = await ui.backfillAll();
          if (report.totalChunksAdded > 0) {
            logger.info(`[dream] Post-dream reindex: +${report.totalChunksAdded} chunks across ${report.totalFilesScanned} files`);
          }
        }
      } catch (e) { logger.warn("[dream] Post-dream reindex failed:", (e as Error).message); }

      const recentCount = sessionStore.list().filter(s => s.updatedAt > Date.now() - 24 * 60 * 60 * 1000).length;
      completeDream(recentCount);
      logger.info(`[dream] Memory consolidation finished (${batches.length} batch(es))`);
    } catch (e) {
      logger.warn("[dream] Failed:", (e as Error).message);
      try { const { failDream } = await import("../memory-dream.js"); failDream(); } catch {}
    }
  };
  scheduler.register({
    name: "dream-check",
    intervalMs: 2 * 60 * 60 * 1000,
    startupDelayMs: 5 * 60 * 1000,
    run: runDreamCheck,
  });

  setTimeout(async () => {
    try {
      const { getUniversalIndex } = await import("../memory/universal-index.js");
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
