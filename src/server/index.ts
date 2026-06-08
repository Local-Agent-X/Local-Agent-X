import { AppRegistry } from "../app-runtime/index.js";
import { AgentRunStore, AgentTemplateStore, IssueStore, ProjectStore } from "../agent-store/index.js";
import { broadcastAll } from "../chat-ws/index.js";
import type { LAXConfig } from "../types.js";
import type { ServerContext } from "../server-context.js";
import { bootstrapServices } from "./bootstrap-services.js";
import { bootstrapTools } from "./bootstrap-tools.js";
import { createBridgeHandler, bootstrapBridges } from "./bootstrap-bridges.js";
import { createSessionHelpers } from "./session-helpers.js";
import { createRequestHandler } from "./request-handler.js";
import { createHttpServer, setupVoiceWs, wireWsChat, startConfigWatcher, logStartup, registerShutdown, bootstrapCanonicalLoop, startSecurityKernel } from "./lifecycle.js";
import { registerHandlerEvents } from "./handler-events.js";
import { startBackgroundJobs } from "./background-jobs.js";
import { createLogger } from "../logger.js";
import type { ProviderId } from "../providers/provider-ids.js";

const bootLogger = createLogger("server.index");

export async function startServer(config: LAXConfig) {
  // Per-phase boot timing. Boot has crept up to 60-90s on developer
  // machines and we kept guessing which phase. Now every blocking
  // section logs its duration so the next time someone says "the app
  // takes forever to start" we have data, not theories. Phases that
  // intentionally run in background (tool-RAG pre-warm, memory backfill)
  // are excluded — they don't gate /api/health.
  const _bootT0 = Date.now();
  const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      const out = await fn();
      bootLogger.info(`[boot-phase] ${name} ${Date.now() - t}ms`);
      return out;
    } catch (e) {
      bootLogger.error(`[boot-phase] ${name} FAILED after ${Date.now() - t}ms: ${(e as Error).message}`);
      throw e;
    }
  };
  const phaseSync = <T>(name: string, fn: () => T): T => {
    const t = Date.now();
    const out = fn();
    const dt = Date.now() - t;
    if (dt > 50) bootLogger.info(`[boot-phase] ${name} ${dt}ms`);
    return out;
  };

  const services = await phase("bootstrapServices", () => bootstrapServices(config));
  const { security, publicDir, dataDir, toolPolicy, rbac, agentSync, sessionStore, memoryIndex, memoryManager, secretsStore, cronService, integrations } = services;

  // Provider matrix + session bridge bootstrap. Canonical-loop ops run
  // in-process and don't need a worker pool; the session bridge owns the
  // session-to-op binding used by op_status / sidebar wiring.
  const { bootstrapProviderMatrix } = await import("../ops/provider-matrix.js");
  const { initSessionBridge, setSessionPersister } = await import("../ops/session-bridge.js");
  bootstrapProviderMatrix();
  initSessionBridge();
  // Persist worker completion acks (session-bridge worker-completed path)
  // into session.messages. The idle-nudge proactive narration deliberately
  // does NOT persist: it announces completion live to the user, but the
  // agent's antecedent for a follow-up reply ("yes") comes from the
  // pending-notifications completion block injected into the system prompt
  // on the next turn — a provider-uniform channel that doesn't depend on a
  // synthetic transcript message.
  const persistAssistant = (sessionId: string, content: string) => {
    try {
      const session = sessionStore.load(sessionId);
      if (!session) return;
      session.messages.push({ role: "assistant", content });
      session.updatedAt = Date.now();
      sessionStore.save(session);
    } catch { /* persister must never break worker completion */ }
  };
  setSessionPersister(persistAssistant);

  // Auto-resume any orchestrator runs that were in flight when LAX last
  // died. Fire-and-forget — never blocks boot. Skips if the feature flag
  // is off OR no in-flight registry entries exist (the common case).
  void (async () => {
    try {
      const { autoResumeOrchestrations } = await import("../primal-auto-build/orchestrator/resume.js");
      const report = autoResumeOrchestrations();
      if (report.attempted > 0) {
        bootLogger.info(`[orchestrator-resume] scanned ${report.attempted}: ${report.resumed} resumed, ${report.abandoned} abandoned, ${report.cleared} cleared`);
      }
    } catch (e) {
      bootLogger.warn(`[orchestrator-resume] scan failed: ${(e as Error).message}`);
    }
  })();

  const tools = await phase("bootstrapTools", () => bootstrapTools({ secretsStore, cronService, memoryIndex, dataDir }));
  const { allAgentTools, bridgeTools, toolRegistry, activeOnEventBySession, activeBrowserSessionIdRef, activeRuntimeBySession } = tools;

  // Boot-time coverage audit — catch newly-registered tools that don't
  // have a matching policy rule (would hit deny-by-default at runtime).
  // Same shape as runSecurityAudit + printAuditReport already wired in
  // logStartup. We dedupe by name across allAgentTools + bridgeTools
  // since some tools register on both surfaces. The report goes to the
  // startup banner via the same logger.error path; if any tool is
  // uncovered, it'll be visible immediately on server boot instead of
  // surfacing as a "BLOCKED by tool-policy" failure to a real user.
  {
    const { auditPolicyCoverage, printPolicyCoverageReport } = await import("../tool-policy.js");
    const { auditKernelCoverage, printKernelCoverageReport } = await import("../ari-kernel/index.js");
    const seen = new Set<string>();
    const names: string[] = [];
    for (const t of [...allAgentTools, ...bridgeTools]) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      names.push(t.name);
    }
    printPolicyCoverageReport(auditPolicyCoverage(names, toolPolicy));
    // Twin audit for AriKernel's TOOL_CLASS_MAP. Unmapped tools fail
    // closed at runtime — surface the gap at boot so devs catch it before
    // a user does. (The TOOL_CLASS_MAP × TOOL_RISK alignment invariant
    // that used to be a runtime audit is now enforced at compile time
    // via the single TOOLS record in src/tool-registry.ts.)
    printKernelCoverageReport(auditKernelCoverage(names));
  }

  // Pre-warm the tool-RAG embedding index in the background. Without this,
  // the FIRST chat after every server restart paid 30-50s to embed all ~66
  // tool descriptions before the lazy `rag.size === 0` branch in
  // prepareAgentRequest could resolve. Pre-warming amortizes that cost
  // once at startup; by the time a user sends their first message, the
  // index is built and prep falls through to the cheap `rag.select()`
  // path instead. Fire-and-forget — don't block server startup.
  void (async () => {
    try {
      const t0 = Date.now();
      const { getToolRAG } = await import("../tool-rag.js");
      const { join } = await import("node:path");
      const rag = getToolRAG();
      const embedder = (memoryIndex as unknown as {
        embeddingProvider?: { embed(t: string): Promise<number[]>; name?: string; model?: string; dimensions?: number };
      }).embeddingProvider;
      if (!embedder) {
        bootLogger.info("[tool-rag] pre-warm skipped — no embedding provider");
        return;
      }
      if (rag.size > 0) return;
      rag.setEmbedder(embedder);
      // Persist vectors across reboots, keyed by embedder identity so a model
      // switch invalidates the cache and forces a clean re-embed.
      const modelKey = `${embedder.name ?? "unknown"}/${embedder.model ?? "unknown"}/${embedder.dimensions ?? 0}`;
      rag.setCache({ path: join(dataDir, "tool-rag-cache.json"), modelKey });
      await rag.build(allAgentTools);
      bootLogger.info(`[tool-rag] pre-warmed ${allAgentTools.length} tools in ${Date.now() - t0}ms`);
    } catch (e) {
      bootLogger.warn(`[tool-rag] pre-warm failed: ${(e as Error).message}`);
    }
  })();

  // Pre-warm the memory RETRIEVAL path (embed query + vector + reranker +
  // orchestrator). The tool-RAG warm above loads the embedder, but the
  // reranker (a separate cross-encoder) lazy-loads on the first real
  // retrieval — measured 2026-06-06 as a 3-10s spike on the first chat/voice
  // turn of a session (buildTurnContextCached cold). Firing one throwaway
  // retrieval at boot moves that cost off the user's first turn. skipDailyLog
  // so the warmup leaves no session side-effects. Fire-and-forget.
  void (async () => {
    try {
      const t0 = Date.now();
      const { buildTurnContextCached } = await import("../agent-request/turn-context-cache.js");
      await buildTurnContextCached(memoryManager, {
        userMessage: "warmup",
        sessionId: "boot-warmup",
        sessionMessages: [],
        skipDailyLog: true,
      });
      bootLogger.info(`[memory] retrieval path pre-warmed in ${Date.now() - t0}ms`);
    } catch (e) {
      bootLogger.warn(`[memory] pre-warm failed: ${(e as Error).message}`);
    }
  })();

  // Wire autopilot tool context — resolves provider/model/key on each invocation
  // so auth refreshes don't leave stale credentials inside the autopilot tools.
  const { setAutopilotToolsContext } = await import("../autopilot/tools.js");
  const { resolveProvider } = await import("../agent-request/index.js");
  const { join: pathJoin } = await import("node:path");
  setAutopilotToolsContext(async () => {
    try {
      const { provider, apiKey, model } = await resolveProvider(config, secretsStore, dataDir);
      if (!apiKey) return null;
      return {
        config, apiKey, model,
        provider: provider as ProviderId,
        allTools: allAgentTools,
        workspaceDir: pathJoin(dataDir, "operations"),
      };
    } catch { return null; }
  });

  const sessionHelpers = createSessionHelpers({ sessionStore, memoryIndex, dataDir, maxCached: config.maxCachedSessions });
  const { sessions, getOrCreateSession, saveSession, flushSession } = sessionHelpers;

  const allAgentToolsRef = { value: allAgentTools };
  const bridgeToolsRef = { value: bridgeTools };

  const bridgeHolder: { whatsappBridge: import("../whatsapp-bridge/index.js").WhatsAppBridge | null; telegramBridge: import("../telegram-bridge/index.js").TelegramBridge | null } = { whatsappBridge: null, telegramBridge: null };
  const bridgeHandler = createBridgeHandler({
    sessions, sessionStore, getOrCreateSession, saveSession,
    config, dataDir, memoryIndex, memoryManager, integrations, secretsStore,
    allAgentToolsRef, bridgeToolsRef, security, toolPolicy, rbac,
    getWhatsappBridge: () => bridgeHolder.whatsappBridge!,
    getTelegramBridge: () => bridgeHolder.telegramBridge!,
  });
  const { whatsappBridge, telegramBridge } = bootstrapBridges({ dataDir, secretsStore, bridgeHandler });
  bridgeHolder.whatsappBridge = whatsappBridge;
  bridgeHolder.telegramBridge = telegramBridge;

  const agentRunStore = AgentRunStore.getInstance();
  const agentTemplateStore = AgentTemplateStore.getInstance();
  const issueStore = IssueStore.getInstance();
  const projectStore = ProjectStore.getInstance();

  const chatWsHolder: { value: ServerContext["chatWs"] | null } = { value: null };
  const requestHandler = createRequestHandler({
    config, security, toolPolicy, rbac, dataDir, publicDir, sessionStore, memoryIndex, memoryManager, secretsStore, cronService, integrations,
    whatsappBridge, telegramBridge, agentSync, appRegistry: AppRegistry.getInstance(), agentRunStore, agentTemplateStore, issueStore, projectStore,
    allAgentTools, toolRegistry, bridgeTools, getOrCreateSession, saveSession, flushSession,
    getChatWs: () => chatWsHolder.value!, broadcastAll,
    activeOnEventBySession,
    activeBrowserSessionIdRef,
    activeRuntimeBySession,
  });

  const { server, chatWs } = phaseSync("createHttpServer", () => createHttpServer(requestHandler, { config, dataDir }));
  chatWsHolder.value = chatWs;

  // Wire the message-count provider used by the WS session_snapshot event.
  // chat-ws can't import SessionStore directly (would pull memory.ts into a
  // layer that should stay transport-only), so we hand it a closure here.
  {
    const { setMessageCountForSession } = await import("../chat-ws/state.js");
    setMessageCountForSession((id) => sessionStore.load(id)?.messages?.length ?? 0);
  }

  await phase("setupVoiceWs", () => setupVoiceWs({ server, config, dataDir, memoryIndex, memoryManager, integrations, secretsStore, allAgentTools, bridgeTools, security, toolPolicy, rbac, activeOnEventBySession }));

  // The WS forward layer calls into the same chat-turn helper the HTTP
  // /api/chat route uses (no more localhost HTTP self-loop). It needs a
  // ServerContext to do so; build one on demand from the same dependencies
  // request-handler.ts assembles per-request. WS auth happens at handshake
  // time, so a fixed `operator` role is correct for WS-initiated chats.
  const buildWsCtx = (): ServerContext => ({
    config, security, toolPolicy, rbac, dataDir, publicDir,
    sessionStore, memoryIndex, memoryManager, secretsStore, cronService, integrations,
    whatsappBridge, telegramBridge, agentSync,
    appRegistry: AppRegistry.getInstance(),
    agentRunStore, agentTemplateStore, issueStore, projectStore,
    allAgentTools, toolRegistry, bridgeTools,
    getOrCreateSession, saveSession, flushSession,
    chatWs, broadcastAll,
    getActiveOnEvent: (sid) => activeOnEventBySession.get(sid),
    setActiveOnEvent: (sid, fn) => {
      if (fn) activeOnEventBySession.set(sid, fn);
      else activeOnEventBySession.delete(sid);
    },
    activeBrowserSessionId: activeBrowserSessionIdRef.value,
    setActiveBrowserSessionId: (id) => { activeBrowserSessionIdRef.value = id; },
    getActiveRuntime: (sid) => activeRuntimeBySession.get(sid),
    setActiveRuntime: (sid, runtime) => {
      if (runtime) activeRuntimeBySession.set(sid, runtime);
      else activeRuntimeBySession.delete(sid);
    },
  });
  wireWsChat({ chatWs, buildCtx: buildWsCtx });

  registerHandlerEvents({
    config, dataDir, sessions, sessionStore, memoryIndex, secretsStore, security, toolPolicy,
    allAgentTools, agentRunStore, agentTemplateStore, broadcastAll,
  });

  phaseSync("startConfigWatcher", () => startConfigWatcher(dataDir));
  phaseSync("bootstrapCanonicalLoop", () => bootstrapCanonicalLoop());

  // Security guardian is a boot precondition — must be up before we accept
  // a single request. When ariRequired, a failure here exits the process.
  await phase("startSecurityKernel", () => startSecurityKernel({ config, dataDir }));

  let jobScheduler: import("./scheduler.js").JobScheduler | undefined;
  server.listen(config.port, "127.0.0.1", () => {
    bootLogger.info(`[boot-phase] TOTAL ${Date.now() - _bootT0}ms (port ${config.port} listening)`);
    logStartup({ config, dataDir });

    // The server bound successfully — confirm any pending self_edit merge so the
    // boot-time crashed-merge guard knows the merged code actually boots.
    void import("../self-edit-rollback.js")
      .then(m => m.confirmMergeBoot())
      .catch(e => bootLogger.warn(`[self-edit] confirmMergeBoot failed: ${(e as Error).message}`));
    const handle = startBackgroundJobs({
      config, dataDir, sessionStore, memoryIndex, memoryManager, secretsStore, security, toolPolicy,
      cronService, integrations, agentSync, allAgentTools, bridgeTools,
      getOrCreateSession, saveSession,
    });
    jobScheduler = handle.scheduler;

    // Stall watchdog — system-level sweep that escalates silent agents
    // every 15 minutes. Not a user-authored cron job (so it doesn't go
    // through CronService); registerShutdown stops it on SIGINT.
    void (async () => {
      try {
        const { WatchdogService } = await import("../agents/watchdog.js");
        WatchdogService.getInstance().start();
      } catch (e) {
        bootLogger.warn(`[watchdog] start failed: ${(e as Error).message}`);
      }
    })();
  });

  registerShutdown({
    getScheduler: () => jobScheduler,
    cronService, agentSync, memoryIndex, secretsStore,
  });

  return server;
}
