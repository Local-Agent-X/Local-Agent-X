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
import type { MemoryManager } from "../memory-manager.js";
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
  memoryManager: MemoryManager;
  integrations: IntegrationRegistry;
  secretsStore: SecretsStore;
  allAgentTools: ToolDefinition[];
  bridgeTools: ToolDefinition[];
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  rbac: RBACManager;
}): Promise<void> {
  const {
    server, config, dataDir, memoryIndex, memoryManager, integrations,
    secretsStore, allAgentTools, bridgeTools, security, toolPolicy, rbac,
  } = deps;
  try {
    const { setupVoiceWebSocket, setVoiceSessionFactory } = await import("../voice/audio-ws.js");
    const { createVoiceSessionFactory } = await import("../voice/voice-session.js");
    const { prepareAgentRequest } = await import("../agent-request.js");
    setupVoiceWebSocket(server, config.authToken);

    const voiceTurnRunner: import("../voice/voice-session.js").VoiceTurnRunner = async ({ text, history, signal, onDelta }) => {
      // Voice goes through the full agent pipeline so it knows the persona
      // (Primal), has memory access, and can call tools. Earlier we routed
      // voice through a stripped-down LLM call to chase latency, but the
      // savings turned out to be marginal vs prompt caching, and the agent
      // appearing to forget who it was made the experience feel broken.
      //
      // The voice path differs from text chat in three ways:
      //   1. No threat engine / canary scanning (voice stream is short)
      //   2. No turn-lock / queue (voice has its own session-level concurrency)
      //   3. No fallback chain (voice picks the configured provider; an error
      //      surfaces as agent_error to the client which will retry)
      const sessionMessages = history.map(m => ({
        role: (m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : "user") as "user" | "assistant" | "system",
        content: typeof m.content === "string" ? m.content : "",
      }));

      const prepared = await prepareAgentRequest({
        channel: "web",
        message: text,
        sessionMessages,
        sessionId: "voice",
        config, dataDir,
        memoryIndex, memoryManager, integrations, secretsStore,
        allAgentTools, bridgeTools,
      });

      if (!prepared.apiKey) {
        throw new Error(`No API key configured for ${prepared.provider}.`);
      }

      // Voice-mode policy: persona + memory yes, tools NO. The agent in text
      // chat has dozens of tools (http_request, browser_*, settings, etc.)
      // and eagerly uses them — but in voice that produced a turn that
      // changed the user's voice setting mid-conversation, then went into
      // a 40k-token tool-exploration loop before aborting. Voice is a
      // conversation, not an action surface. We strip tools and append a
      // short voice-mode instruction so the agent knows to reply in 1-3
      // short spoken sentences with no markdown.
      const voiceTools: ToolDefinition[] = [];
      const voiceSystemPrompt = prepared.systemPrompt +
        "\n\n## Voice mode\n" +
        "You are speaking to the user. Your reply will be read aloud by TTS. " +
        "Reply in 1-3 short conversational sentences. No markdown, no lists, " +
        "no code, no headings, no emoji. Use natural spoken English. " +
        "You have no tools right now — don't try to call any. If the user " +
        "needs something tool-driven (open an app, change a setting, search " +
        "the web), tell them to switch to the text chat for that.";

      let assistantText = "";
      const onEvent = (event: ServerEvent) => {
        if (event.type === "stream" && event.delta) {
          assistantText += event.delta;
          onDelta(event.delta);
        }
      };

      await runAgent(text, prepared.cleanHistory, {
        apiKey: prepared.apiKey,
        model: prepared.model,
        provider: prepared.provider as AgentOptions["provider"],
        baseURL: prepared.customBaseURL,
        systemPrompt: voiceSystemPrompt,
        tools: voiceTools,
        security, toolPolicy, rbac,
        sessionId: "voice",
        maxIterations: 1,  // single turn — no tool loops
        temperature: prepared.temperature,
        signal,
        onEvent,
      });

      const updatedHistory = [
        ...history,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: assistantText },
      ];

      return { assistantText, updatedHistory };
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
