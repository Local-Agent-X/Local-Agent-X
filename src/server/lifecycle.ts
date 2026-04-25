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
  runMigrations(dataDir).catch(e => console.warn("[migrations]", e.message));
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

    const voiceTurnRunner: import("../voice/voice-session.js").VoiceTurnRunner = async ({ text, history, sessionId, signal, onDelta }) => {
      const prepared = await prepareAgentRequest({
        channel: "web", message: text, sessionMessages: history, sessionId,
        config, dataDir, memoryIndex, integrations, secretsStore,
        allAgentTools, bridgeTools, maxHistory: 40,
      });
      const voiceDirective = "\n\n[voice mode] Your response will be spoken aloud. Write one short, conversational reply — two or three sentences max. No markdown, headings, bullets, code blocks, or emoji. Avoid lists. Use normal sentences a human would speak.";
      const result = await runAgent(text, prepared.cleanHistory, {
        apiKey: prepared.apiKey, model: prepared.model,
        provider: prepared.provider as AgentOptions["provider"],
        systemPrompt: prepared.systemPrompt + voiceDirective,
        tools: prepared.tools,
        security, toolPolicy, rbac, callerRole: "operator" as const,
        sessionId, maxIterations: prepared.maxIterations,
        temperature: prepared.temperature,
        signal,
        onEvent: (ev: ServerEvent) => {
          if (ev.type === "stream" && typeof ev.delta === "string") onDelta(ev.delta);
        },
      });
      const assistantText = result.messages.filter(m => m.role === "assistant" && typeof m.content === "string").map(m => m.content as string).pop() || "";
      return { assistantText, updatedHistory: result.messages };
    };

    setVoiceSessionFactory(createVoiceSessionFactory(voiceTurnRunner));
  } catch (e) { console.warn("[voice-ws] setup failed:", (e as Error).message); }
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
      console.warn(`[ws-chat] Error:`, (e as Error).message);
    }
  });
}

export function startConfigWatcher(dataDir: string): void {
  new ConfigWatcher().start(join(dataDir, "config.json"), () => console.log("[config] Hot-reloaded"));
}

export function logStartup(deps: { config: LAXConfig; dataDir: string }): void {
  const { config, dataDir } = deps;
  const masked = config.authToken ? config.authToken.slice(0, 4) + "****" + config.authToken.slice(-4) : "none";
  console.log(`\n  Open Agent X running at http://127.0.0.1:${config.port}\n  Auth token: ${masked}`);
  const realUrl = `http://127.0.0.1:${config.port}/?token=${config.authToken}`;
  writeFileSync(join(dataDir, ".startup-url"), realUrl, { mode: 0o600 });
  console.log(`\n  ► Open: \x1b]8;;${realUrl}\x1b\\http://127.0.0.1:${config.port}/?token=${masked}\x1b]8;;\x1b\\\n  Memory: ${dataDir}/memory/\n  Sessions: ${dataDir}/sessions/`);
  printAuditReport(runSecurityAudit({ authToken: config.authToken, workspace: config.workspace }));
  startAriKernel(join(dataDir, "ari-audit.db"), undefined, config.ariRequired).then(a => { if (a) console.log(`  [ari] Audit active`); else if (config.ariRequired) console.error(`  [ari] CRITICAL: ARI failed`); });
  try { import("../auth-refresh.js").then(({ startAuthRefreshTimer }) => startAuthRefreshTimer()).catch(() => {}); } catch {}
}

export function registerShutdown(deps: {
  getMemBgTimer: () => ReturnType<typeof setInterval> | undefined;
  cronService: CronService;
  agentSync: AgentSync;
  memoryIndex: MemoryIndex;
  secretsStore: SecretsStore;
}): void {
  const { getMemBgTimer, cronService, agentSync, memoryIndex, secretsStore } = deps;
  process.on("SIGINT", async () => {
    clearInterval(getMemBgTimer());
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
