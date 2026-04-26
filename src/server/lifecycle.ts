import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type AgentOptions } from "../agent.js";
import { setupChatWebSocket } from "../chat-ws.js";
import { runSecurityAudit, printAuditReport } from "../security-audit.js";
import { startAriKernel } from "../ari-kernel.js";
import { runMigrations } from "../db-migrations.js";
import { EventBus } from "../event-bus.js";
import { ConfigWatcher } from "../config-hot-reload.js";
import { closeAllBrowsers } from "../browser.js";
import type { LAXConfig, ServerEvent, ToolDefinition } from "../types.js";
import type { MemoryIndex } from "../memory.js";
import type { SecretsStore } from "../secrets.js";
import type { IntegrationRegistry } from "../integrations.js";
import type { SecurityLayer } from "../security.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { RBACManager } from "../rbac.js";
import type { CronService } from "../cron-service.js";
import type { AgentSync } from "../sync.js";
import type { RequestHandler } from "./request-handler.js";

import { createLogger } from "../logger.js";
const logger = createLogger("server.lifecycle");

export interface LifecycleResult {
  server: Server;
  chatWs: ReturnType<typeof setupChatWebSocket>;
}

export function createHttpServer(requestHandler: RequestHandler, deps: {
  config: LAXConfig;
  dataDir: string;
}): LifecycleResult {
  const { config, dataDir } = deps;
  const server = createServer(requestHandler);
  runMigrations(dataDir).catch(e => logger.warn("[migrations]", e.message));
  const chatWs = setupChatWebSocket(server, config.authToken);
  return { server, chatWs };
}

export async function setupVoiceWs(deps: {
  server: Server;
  config: LAXConfig;
  dataDir: string;
  memoryIndex: MemoryIndex;
  integrations: IntegrationRegistry;
  secretsStore: SecretsStore;
  allAgentTools: ToolDefinition[];
  bridgeTools: ToolDefinition[];
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  rbac: RBACManager;
}): Promise<void> {
  const { server, config, dataDir, memoryIndex, integrations, secretsStore, allAgentTools, bridgeTools, security, toolPolicy, rbac } = deps;
  try {
    const { setupVoiceWebSocket, setVoiceSessionFactory } = await import("../voice/audio-ws.js");
    const { createVoiceSessionFactory } = await import("../voice/voice-session.js");
    const { prepareAgentRequest } = await import("../agent-request.js");
    setupVoiceWebSocket(server, config.authToken);

    const { streamVoiceTurn } = await import("../voice/voice-llm.js");
    const { resolveProvider } = await import("../agent-request.js");

    const voiceTurnRunner: import("../voice/voice-session.js").VoiceTurnRunner = async ({ text, history, signal, onDelta }) => {
      // Resolve only the provider/apiKey/model — skip the heavy
      // prepareAgentRequest path (memory orchestrator, tool routing,
      // persona system prompt, etc.). Voice gets a 100-token system
      // prompt + last 5 turns of history fed straight to the streaming
      // client. Drops per-turn input from 6-13k tokens to ~500-1000.
      const resolved = await resolveProvider(config, secretsStore, dataDir);
      return streamVoiceTurn({
        provider: resolved.provider as "codex" | "anthropic" | "openai",
        apiKey: resolved.apiKey,
        model: resolved.model,
        history,
        userMessage: text,
        signal,
        onDelta,
      });
    };

    setVoiceSessionFactory(createVoiceSessionFactory(voiceTurnRunner));
  } catch (e) { logger.warn("[voice-ws] setup failed:", (e as Error).message); }
}

export function wireWsChat(deps: {
  chatWs: ReturnType<typeof setupChatWebSocket>;
  config: LAXConfig;
}): void {
  const { chatWs, config } = deps;
  chatWs.onChat(async (sessionId, message, attachments) => {
    try {
      const body = JSON.stringify({ message, sessionId, attachments: attachments || [] });
      const res = await fetch(`http://127.0.0.1:${config.port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.authToken}` },
        body,
        signal: AbortSignal.timeout(600_000),
      });
      if (res.body) { for await (const _ of res.body) { /* drain */ } }
    } catch (e) {
      logger.warn(`[ws-chat] Error:`, (e as Error).message);
    }
  });
}

export function startConfigWatcher(dataDir: string): void {
  new ConfigWatcher().start(join(dataDir, "config.json"), () => logger.info("[config] Hot-reloaded"));
}

export function logStartup(deps: { config: LAXConfig; dataDir: string }): void {
  const { config, dataDir } = deps;
  const masked = config.authToken ? config.authToken.slice(0, 4) + "****" + config.authToken.slice(-4) : "none";
  logger.info(`\n  Open Agent X running at http://127.0.0.1:${config.port}\n  Auth token: ${masked}`);
  const realUrl = `http://127.0.0.1:${config.port}/?token=${config.authToken}`;
  writeFileSync(join(dataDir, ".startup-url"), realUrl, { mode: 0o600 });
  logger.info(`\n  ► Open: \x1b]8;;${realUrl}\x1b\\http://127.0.0.1:${config.port}/?token=${masked}\x1b]8;;\x1b\\\n  Memory: ${dataDir}/memory/\n  Sessions: ${dataDir}/sessions/`);
  printAuditReport(runSecurityAudit({ authToken: config.authToken, workspace: config.workspace }));
  startAriKernel(join(dataDir, "ari-audit.db"), undefined, config.ariRequired).then(a => { if (a) logger.info(`  [ari] Audit active`); else if (config.ariRequired) logger.error(`  [ari] CRITICAL: ARI failed`); });
  try { import("../auth-refresh.js").then(({ startAuthRefreshTimer }) => startAuthRefreshTimer()).catch(() => {}); } catch {}
}

export function registerShutdown(deps: {
  getScheduler: () => import("./scheduler.js").JobScheduler | undefined;
  cronService: CronService;
  agentSync: AgentSync;
  memoryIndex: MemoryIndex;
  secretsStore: SecretsStore;
}): void {
  const { getScheduler, cronService, agentSync, memoryIndex, secretsStore } = deps;
  process.on("SIGINT", async () => {
    getScheduler()?.stopAll();
    cronService.stop();
    agentSync.stopHeartbeat();
    EventBus.removeAllListeners();
    await agentSync.push().catch(() => {});
    await closeAllBrowsers();
    memoryIndex.close();
    secretsStore.destroy();
    try { const { cleanupAllWorktrees } = await import("../agency/worktree.js"); cleanupAllWorktrees(); } catch {}
    process.exit(0);
  });
}
