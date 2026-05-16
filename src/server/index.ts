import { AppRegistry } from "../app-runtime.js";
import { AgentRunStore, AgentTemplateStore, IssueStore, ProjectStore } from "../agent-store.js";
import { broadcastAll } from "../chat-ws.js";
import type { LAXConfig } from "../types.js";
import type { ServerContext } from "../server-context.js";
import { bootstrapServices } from "./bootstrap-services.js";
import { bootstrapTools } from "./bootstrap-tools.js";
import { createBridgeHandler, bootstrapBridges } from "./bootstrap-bridges.js";
import { createSessionHelpers } from "./session-helpers.js";
import { createRequestHandler } from "./request-handler.js";
import { createHttpServer, setupVoiceWs, wireWsChat, startConfigWatcher, logStartup, registerShutdown, bootstrapCanonicalLoop } from "./lifecycle.js";
import { registerHandlerEvents } from "./handler-events.js";
import { startBackgroundJobs } from "./background-jobs.js";
import { createLogger } from "../logger.js";
import type { ProviderId } from "../providers/provider-ids.js";

const bootLogger = createLogger("server.index");

export async function startServer(config: LAXConfig) {
  const services = await bootstrapServices(config);
  const { security, publicDir, dataDir, toolPolicy, rbac, agentSync, sessionStore, memoryIndex, memoryManager, secretsStore, cronService, integrations } = services;

  // Provider matrix + session bridge bootstrap. Canonical-loop ops run
  // in-process and don't need a worker pool; the session bridge owns the
  // session-to-op binding used by op_status / sidebar wiring.
  const { bootstrapProviderMatrix } = await import("../ops/provider-matrix.js");
  const { initSessionBridge, setSessionPersister } = await import("../ops/session-bridge.js");
  const { setIdleNudgePersister } = await import("../ops/idle-nudge.js");
  bootstrapProviderMatrix();
  initSessionBridge();
  // Persist worker completion acks (session-bridge worker-completed path)
  // AND idle-nudge proactive narrations ("Quick heads up — that op just
  // finished…") into session.messages. Without persistence the UI shows
  // the auto-narration but the agent's history doesn't, so a follow-up
  // user reply like "yes" arrives at the next turn with no antecedent in
  // context — the agent sees only its prior "Started …" reply and
  // misinterprets the "yes" as confirming a fresh spawn. Both surfaces
  // share the same persister shape.
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
  setIdleNudgePersister(persistAssistant);

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

  const tools = await bootstrapTools({ secretsStore, cronService, memoryIndex, dataDir });
  const { allAgentTools, bridgeTools, toolRegistry, activeOnEventBySession, activeBrowserSessionIdRef } = tools;

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
      const rag = getToolRAG();
      const embedder = (memoryIndex as unknown as {
        embeddingProvider?: { embed(t: string): Promise<number[]> };
      }).embeddingProvider;
      if (!embedder) {
        bootLogger.info("[tool-rag] pre-warm skipped — no embedding provider");
        return;
      }
      if (rag.size > 0) return;
      rag.setEmbedder(embedder);
      await rag.build(allAgentTools);
      bootLogger.info(`[tool-rag] pre-warmed ${allAgentTools.length} tools in ${Date.now() - t0}ms`);
    } catch (e) {
      bootLogger.warn(`[tool-rag] pre-warm failed: ${(e as Error).message}`);
    }
  })();

  // Wire autopilot tool context — resolves provider/model/key on each invocation
  // so auth refreshes don't leave stale credentials inside the autopilot tools.
  const { setAutopilotToolsContext } = await import("../autopilot/tools.js");
  const { resolveProvider } = await import("../agent-request.js");
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

  const bridgeHolder: { whatsappBridge: import("../whatsapp-bridge.js").WhatsAppBridge | null; telegramBridge: import("../telegram-bridge.js").TelegramBridge | null } = { whatsappBridge: null, telegramBridge: null };
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
  });

  const { server, chatWs } = createHttpServer(requestHandler, { config, dataDir });
  chatWsHolder.value = chatWs;

  await setupVoiceWs({ server, config, dataDir, memoryIndex, memoryManager, integrations, secretsStore, allAgentTools, bridgeTools, security, toolPolicy, rbac, activeOnEventBySession });

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
  });
  wireWsChat({ chatWs, buildCtx: buildWsCtx });

  registerHandlerEvents({
    config, dataDir, sessions, sessionStore, secretsStore, security, toolPolicy,
    allAgentTools, agentRunStore, agentTemplateStore, broadcastAll,
  });

  startConfigWatcher(dataDir);
  bootstrapCanonicalLoop();

  let jobScheduler: import("./scheduler.js").JobScheduler | undefined;
  server.listen(config.port, "127.0.0.1", () => {
    logStartup({ config, dataDir });
    const handle = startBackgroundJobs({
      config, dataDir, sessionStore, memoryIndex, memoryManager, secretsStore, security, toolPolicy,
      cronService, integrations, agentSync, allAgentTools, bridgeTools,
      getOrCreateSession, saveSession,
    });
    jobScheduler = handle.scheduler;
  });

  registerShutdown({
    getScheduler: () => jobScheduler,
    cronService, agentSync, memoryIndex, secretsStore,
  });

  return server;
}
