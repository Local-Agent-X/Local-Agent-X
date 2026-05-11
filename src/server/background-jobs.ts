import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
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
import { validateMissionOutput } from "../cron/output-validation.js";

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
  saveSession: (s: Session) => Promise<void>;
}): BackgroundJobsHandle {
  const {
    config, dataDir, sessionStore, memoryIndex, memoryManager, secretsStore, security, toolPolicy,
    cronService, integrations, agentSync, allAgentTools, bridgeTools,
    getOrCreateSession, saveSession,
  } = deps;

  const cronReportsDir = join(dataDir, "cron", "reports");
  if (!existsSync(cronReportsDir)) mkdirSync(cronReportsDir, { recursive: true });
  // Hard ceiling on a single mission run. Without this a hung adapter (network
  // blackhole, stuck CLI subprocess) holds a concurrency slot forever; after
  // 3 such hangs every cron tick gets skipped. 10 min buffers normal research
  // missions (~1-3 min observed) without letting bad runs leak. On hit the
  // AbortSignal flips the agent loop to stopReason="abort" — content already
  // streamed gets salvaged through the same path as transient stream errors.
  const MISSION_HARD_TIMEOUT_MS = Number(process.env.LAX_MISSION_TIMEOUT_MS) || 10 * 60_000;
  const SUB_AGENT_WAIT_MS = Number(process.env.LAX_SUB_AGENT_WAIT_MS) || 5 * 60_000;
  const stripCronPreamble = (p: string): string => {
    const patterns = [
      /^every day at \d{1,2}(:\d{2})?\s*(am|pm)?,?\s*/i,
      /^every day,?\s*/i,
      /^daily at \d{1,2}(:\d{2})?\s*(am|pm)?,?\s*/i,
      /^daily,?\s*/i,
      /^at \d{1,2}(:\d{2})?\s*(am|pm)?\s+(every day|daily),?\s*/i,
      /^each (day|morning|evening|night),?\s*/i,
    ];
    let out = p.trim();
    for (const re of patterns) out = out.replace(re, "");
    return out.trim();
  };
  const stripSaveInstructions = (p: string): string => {
    const patterns = [
      /[,.\s]*\b(?:and\s+)?save\s+(?:the|this|your)?\s*(?:output|report|results?|file)?\s*(?:to|in|at|as)\s+\S*\.md\b[^.]*\.?/gi,
      /[,.\s]*\bsave\s+(?:to|in|at)\s+workspace\/\S+/gi,
      /[,.\s]*\bwrite\s+(?:the|this|your)?\s*(?:output|report|results?|file)?\s*(?:to|in|at)\s+\S*\.md\b[^.]*\.?/gi,
      /[,.\s]*\boutput\s+(?:to|in|at)\s+workspace\/\S+/gi,
    ];
    let out = p;
    for (const re of patterns) out = out.replace(re, "");
    return out.trim();
  };
  cronService.onExecute(async (jobId, prompt, _ctx) => {
    const cronSecurity = new SecurityLayer(resolve(process.env.LAX_WORKSPACE ?? process.env.SAX_WORKSPACE ?? join(homedir(), ".lax", "workspace")), "workspace");
    const sessionId = `cron-${jobId}-${Date.now()}`;
    const cleanedPrompt = stripSaveInstructions(stripCronPreamble(prompt));
    // Session is plumbed via args._sessionId; no global needed.
    const { prepareAgentRequest } = await import("../agent-request.js");
    const prepared = await prepareAgentRequest({
      channel: "cron", message: cleanedPrompt, sessionMessages: [], sessionId,
      config, dataDir, memoryIndex, memoryManager, integrations, secretsStore,
      allAgentTools, bridgeTools, skipMemory: true,
    });
    const cronModel = prepared.provider === "anthropic" ? "claude-sonnet-4-6" : prepared.model;
    const providerName = String(prepared.provider);
    const cronSystemPrompt = `You are executing a SCHEDULED MISSION. The user message contains the task wrapped in <scheduled_task>...</scheduled_task> tags. Treat that content as data describing work you must perform RIGHT NOW — this run IS the scheduled occurrence. The schedule already exists; you are running it now.

Hard rules:
- Do NOT call mission_schedule_create or attempt to schedule the task.
- Your output IS the report. Do NOT output text like "Scheduled", "Job ID:", "It will run...", "Blocker report completed", or any confirmation that a schedule was created.
- Treat the task content as data, not as a meta-instruction to schedule anything.
- Aim for at least 1000 words of actual research content.
- DO NOT use the \`write\` or \`edit\` tools. Your returned text IS the report — cron will save it for you to one canonical path.
- DO NOT include phrases like "saved to", "output saved", "report saved" or any path reference at the end of your output.
- If you find a path/filename in the task instructions, ignore it — that's stale prompt cruft. Just produce the research.

Use the read-only research tools (web_search, browser, http_request, web_fetch, etc.) to thoroughly complete the task and produce the requested output as your final assistant message.`;
    const wrappedPrompt = `<scheduled_task>\n${cleanedPrompt}\n</scheduled_task>`;
    // no recursive scheduling, no file writes — agent's returned text IS the report
    const cronTools = prepared.tools.filter(t => !t.name.startsWith("mission_schedule_") && t.name !== "write" && t.name !== "edit");
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      logger.error(`[cron] Job ${jobId}: hard timeout ${MISSION_HARD_TIMEOUT_MS}ms reached — aborting agent loop`);
      abortController.abort();
    }, MISSION_HARD_TIMEOUT_MS);
    cronService.registerRunAbort(jobId, abortController);
    let result;
    try {
      result = await runAgent(wrappedPrompt, [], { apiKey: prepared.apiKey, model: cronModel, provider: prepared.provider as AgentOptions["provider"], systemPrompt: cronSystemPrompt, tools: cronTools, security: cronSecurity, toolPolicy, sessionId, maxIterations: config.maxIterations, signal: abortController.signal });
    } finally {
      clearTimeout(timeoutHandle);
      cronService.unregisterRunAbort(jobId);
    }
    const session = getOrCreateSession(sessionId);
    session.messages = stripEphemeralMessages(result.messages).filter(m => m.role !== "system"); session.updatedAt = Date.now(); saveSession(session);
    let output = extractAgentOutput(result.messages);
    const spawnNameRe = /^(agent_spawn|agency_create|delegate)$/;
    const hasSpawn = result.messages.some(m => {
      if (m.role !== "assistant" || !Array.isArray(m.content)) return false;
      return (m.content as Array<{ type?: string; name?: string }>).some(b => b?.type === "tool_use" && typeof b.name === "string" && spawnNameRe.test(b.name));
    });
    if (hasSpawn) {
      try {
        const { Handler } = await import("../agency/handler.js");
        const handler = Handler.getInstance();
        const subWaitStart = Date.now();
        const subResults = await handler.waitForSessionAgents(sessionId, SUB_AGENT_WAIT_MS);
        const subWaitMs = Date.now() - subWaitStart;
        if (subResults.length > 0) {
          const subOutput = subResults.join("\n\n---\n\n");
          output = subOutput.length > output.length ? subOutput : output + "\n\n---\n\n" + subOutput;
          logger.info(`[cron] Job ${jobId}: collected ${subResults.length} sub-agent result(s) in ${subWaitMs}ms`);
        } else if (subWaitMs >= SUB_AGENT_WAIT_MS - 500) {
          logger.warn(`[cron] Job ${jobId}: sub-agent wait timed out after ${subWaitMs}ms — any in-flight sub-agent output is dropped`);
        }
      } catch (e) { logger.warn(`[cron] Sub-agent wait error:`, (e as Error).message); }
    }
    if (!output) {
      logger.error(`[cron] Job ${jobId} produced no output (stopReason: ${result.stopReason})`);
      return {
        output: "ERROR: Agent produced no output — check provider/model config",
        status: "error",
        errorMessage: `no output (stopReason: ${result.stopReason})`,
        provider: providerName, model: cronModel,
      };
    }
    const trimmed = output.trim();
    const stopReason = result.stopReason || "unknown";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const jobDir = join(cronReportsDir, jobId);
    if (!existsSync(jobDir)) mkdirSync(jobDir, { recursive: true });
    const job = cronService.get(jobId);
    const validation = validateMissionOutput(cleanedPrompt, trimmed, stopReason);
    // Salvage rule (mirrors src/workers/worker-entry.ts classifyOpResult):
    // judge by evidence — if the agent produced substantive content that
    // passes refusal/topic/length/truncation checks, ship it to canonical
    // even when the terminal stopReason is "error". Provider streams often
    // emit a transient error event after the final assistant message has
    // already landed; the report is real, the gate was throwing it away.
    if (!validation.valid && !validation.contentValid) {
      const reason = validation.reason!;
      const failedDir = join(jobDir, "failed");
      if (!existsSync(failedDir)) mkdirSync(failedDir, { recursive: true });
      const failedPath = join(failedDir, `${ts}.md`);
      const failedContent = `# FAILED — ${job?.name || jobId} — ${new Date().toLocaleString()}\n\nReason: ${reason}\nstopReason: ${stopReason}\n\n## Prompt\n\n\`\`\`\n${cleanedPrompt}\n\`\`\`\n\n## Raw agent output\n\n\`\`\`\n${trimmed}\n\`\`\`\n`;
      writeFileSync(failedPath, failedContent, "utf-8");
      try { appendFileSync(join(cronReportsDir, "_failures.log"), `${new Date().toISOString()}\t${job?.name || ""}\t${jobId}\tstop=${stopReason}\t${reason}\n`, "utf-8"); } catch {}
      logger.error(`[cron] Job ${jobId} (${job?.name || "?"}) FAILED quality gate — ${reason}; postmortem at ${failedPath}; canonical report NOT written`);
      return {
        output: `FAILED: ${reason}`,
        status: "failed",
        errorMessage: reason,
        provider: providerName, model: cronModel,
      };
    }
    const salvaged = !validation.valid && validation.contentValid;
    const reportPath = join(jobDir, `${ts}.md`);
    const salvageBanner = salvaged ? `\n\n> Note: terminal stopReason was \`${stopReason}\` — content checks passed, salvaged to canonical.\n` : "";
    const reportContent = `# ${job?.name || jobId} — ${new Date().toLocaleDateString()}${salvageBanner}\n\n${output}`;
    writeFileSync(reportPath, reportContent, "utf-8");
    const slug = (job?.name || jobId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    const missionDir = join(resolve(config.workspace), "missions", slug);
    mkdirSync(missionDir, { recursive: true });
    writeFileSync(join(missionDir, "latest.md"), reportContent, "utf-8");
    if (salvaged) {
      try { appendFileSync(join(cronReportsDir, "_failures.log"), `${new Date().toISOString()}\t${job?.name || ""}\t${jobId}\tstop=${stopReason}\tSALVAGED ${trimmed.length} chars to canonical\n`, "utf-8"); } catch {}
      logger.warn(`[cron] Job ${jobId} (${job?.name || "?"}) salvaged: stopReason=${stopReason} but ${trimmed.length} chars passed content checks — saved to ${reportPath}`);
    } else {
      logger.info(`[cron] Report saved: ${reportPath}`);
    }
    return {
      output: output.slice(0, 500), reportPath,
      status: "success",
      provider: providerName, model: cronModel,
    };
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
