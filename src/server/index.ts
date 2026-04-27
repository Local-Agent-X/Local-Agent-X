import { AppRegistry } from "../app-runtime.js";
import { AgentRunStore, AgentTemplateStore, IssueStore, ProjectStore } from "../agent-store.js";
import { broadcastAll } from "../chat-ws.js";
import type { LAXConfig, ServerEvent } from "../types.js";
import type { ServerContext } from "../server-context.js";
import { bootstrapServices } from "./bootstrap-services.js";
import { bootstrapTools } from "./bootstrap-tools.js";
import { createBridgeHandler, bootstrapBridges } from "./bootstrap-bridges.js";
import { createSessionHelpers } from "./session-helpers.js";
import { createRequestHandler } from "./request-handler.js";
import { createHttpServer, setupVoiceWs, wireWsChat, startConfigWatcher, logStartup, registerShutdown } from "./lifecycle.js";
import { registerHandlerEvents } from "./handler-events.js";
import { startBackgroundJobs } from "./background-jobs.js";

export async function startServer(config: LAXConfig) {
  const services = await bootstrapServices(config);
  const { security, publicDir, dataDir, toolPolicy, rbac, agentSync, sessionStore, memoryIndex, memoryManager, secretsStore, cronService, integrations } = services;

  const tools = await bootstrapTools({ secretsStore, cronService, memoryIndex, dataDir });
  const { allAgentTools, bridgeTools, toolRegistry, activeOnEventRef, activeBrowserSessionIdRef } = tools;

  const sessionHelpers = createSessionHelpers({ sessionStore, memoryIndex, dataDir, maxCached: config.maxCachedSessions });
  const { sessions, getOrCreateSession, saveSession } = sessionHelpers;

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
    allAgentTools, toolRegistry, bridgeTools, getOrCreateSession, saveSession,
    getChatWs: () => chatWsHolder.value!, broadcastAll,
    activeOnEventRef: activeOnEventRef as { value: ((event: ServerEvent) => void) | undefined },
    activeBrowserSessionIdRef,
  });

  const { server, chatWs } = createHttpServer(requestHandler, { config, dataDir });
  chatWsHolder.value = chatWs;

  await setupVoiceWs({ server, config, dataDir, memoryIndex, memoryManager, integrations, secretsStore, allAgentTools, bridgeTools, security, toolPolicy, rbac });
  wireWsChat({ chatWs, config });

  registerHandlerEvents({
    config, dataDir, sessions, sessionStore, secretsStore, security, toolPolicy,
    allAgentTools, agentRunStore, agentTemplateStore, broadcastAll,
  });

  startConfigWatcher(dataDir);

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
