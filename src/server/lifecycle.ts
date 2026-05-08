import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runAgent, type AgentOptions } from "../agent.js";
import { setupChatWebSocket } from "../chat-ws.js";
import { runSecurityAudit, printAuditReport } from "../security-audit.js";
import { startAriKernel } from "../ari-kernel.js";
import { runMigrations } from "../db-migrations.js";
import { EventBus } from "../event-bus.js";
import { ConfigWatcher } from "../config-hot-reload.js";
import { closeAllBrowsers } from "../browser.js";
import type { LAXConfig, ServerEvent, ToolDefinition } from "../types.js";
import type { MemoryIndex, MemoryManager } from "../memory.js";
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

// Re-export for backward compatibility — server/index.ts imports it from here.
export { bootstrapCanonicalLoop } from "./canonical-loop-bootstrap.js";

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
  /** Shared registry mapping sessionId → onEvent sink. Anthropic routes
   *  tool calls through the MCP bridge (`/api/mcp/call`), which looks up
   *  the session's onEvent here to fire side-effect events. Without
   *  registering the voice session's sink, voice_visual's emits get
   *  dropped on Anthropic (they work on Codex which calls natively). */
  activeOnEventBySession: Map<string, (event: ServerEvent) => void>;
}): Promise<void> {
  const {
    server, config, dataDir, memoryIndex, memoryManager, integrations,
    secretsStore, allAgentTools, bridgeTools, security, toolPolicy, rbac,
    activeOnEventBySession,
  } = deps;
  try {
    const { setupVoiceWebSocket, setVoiceSessionFactory } = await import("../voice/audio-ws.js");
    const { createVoiceSessionFactory } = await import("../voice/voice-session.js");
    const { prepareAgentRequest } = await import("../agent-request.js");
    setupVoiceWebSocket(server, config.authToken);

    const voiceTurnRunner: import("../voice/voice-session.js").VoiceTurnRunner = async ({ text, history, signal, onDelta, onVisual, sessionId: voiceSessionId }) => {
      // Per-connection voice session id. The previous hardcoded "voice" caused
      // every concurrent voice connection to share global session-scoped state
      // (active onEvent callback, browser session, sub-agent inheritance).
      // Each voice WebSocket sends its own sessionId in the hello frame; here
      // we trust it so memory writes, retrieval, and tool plumbing isolate.
      const sessionId = voiceSessionId && voiceSessionId.trim() ? voiceSessionId : `voice-${randomUUID()}`;
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
        sessionId,
        config, dataDir,
        memoryIndex, memoryManager, integrations, secretsStore,
        allAgentTools, bridgeTools,
      });

      if (!prepared.apiKey) {
        throw new Error(`No API key configured for ${prepared.provider}.`);
      }

      // Voice-mode policy: persona + memory yes, tools mostly NO. The agent
      // in text chat has dozens of tools (http_request, browser_*, settings,
      // etc.) and eagerly uses them — but in voice that produced a turn that
      // changed the user's voice setting mid-conversation, then went into a
      // 40k-token tool-exploration loop before aborting. Voice is a
      // conversation, not an action surface.
      //
      // Exception: when voice_visuals_enabled is on (default), we expose
      // ONE tightly-scoped tool — voice_visual — that lets the agent morph
      // the on-screen particle sphere into emojis/text/shapes/moods when
      // something is emotionally significant. The tool is rate-limited
      // server-side (1 call/turn + 2.5s cooldown) so it can't be abused.
      // Read the live toggle from settings.json so a flip in the UI takes
      // effect on the next voice turn — no restart required.
      let visualsEnabled = config.voice_visuals_enabled !== false;
      try {
        const { readFileSync, existsSync } = await import("node:fs");
        const settingsPath = join(dataDir, "settings.json");
        if (existsSync(settingsPath)) {
          const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
          if (typeof s.voice_visuals_enabled === "boolean") {
            visualsEnabled = s.voice_visuals_enabled;
          }
        }
      } catch { /* keep config-default */ }
      let voiceTools: ToolDefinition[] = [];
      if (visualsEnabled) {
        const tool = allAgentTools.find(t => t.name === "voice_visual");
        if (tool) voiceTools = [tool];
      }
      const visualPromptTail = visualsEnabled
        ? "\nYou have one tool: voice_visual(kind, value). Use it RARELY — " +
          "only when something is emotionally significant. Most replies have " +
          "no tool call. The system enforces max 1 call per reply with a 2.5s " +
          "cooldown, so don't try to chain them. Never narrate the call (\"let " +
          "me show you\"); just call it. Examples:\n" +
          "  voice_visual({kind:\"mood\", value:\"excited\"}) — user shares good news\n" +
          "  voice_visual({kind:\"emoji\", value:\"🙂\"}) — friendly beat\n" +
          "  voice_visual({kind:\"shape\", value:\"heart\"}) — sweet moment\n" +
          "  voice_visual({kind:\"text\", value:\"yes!\"}) — emphatic agreement\n" +
          "  voice_visual({kind:\"mood\", value:\"thinking\"}) — working through something\n" +
          "Default to NO call. Quality > frequency."
        : "\nYou have no tools right now — don't try to call any. If the user " +
          "needs something tool-driven (open an app, change a setting, search " +
          "the web), tell them to switch to the text chat for that.";
      const voiceSystemPrompt = prepared.systemPrompt +
        "\n\n## Voice mode\n" +
        "You are speaking to the user. Your reply will be read aloud by TTS. " +
        "Reply in 1-3 short conversational sentences. No markdown, no lists, " +
        "no code, no headings, no emoji in the spoken text. Use natural " +
        "spoken English." + visualPromptTail;

      let assistantText = "";
      const onEvent = (event: ServerEvent) => {
        if (event.type === "stream" && event.delta) {
          assistantText += event.delta;
          onDelta(event.delta);
        } else if (event.type === "visual" && onVisual) {
          // Forward the visual directive through to the voice WebSocket.
          onVisual(event.kind, event.value, event.durationMs);
        }
      };

      // Register this session's onEvent in the shared map so the MCP bridge
      // (Anthropic's tool path) can fire side-effect events that reach the
      // voice WebSocket. Codex calls voice_visual natively and uses the
      // _onEvent injection in tool-executor.ts, so this is only required
      // for Anthropic, but registering unconditionally is harmless.
      const hadPrev = activeOnEventBySession.has(sessionId);
      const prev = activeOnEventBySession.get(sessionId);
      activeOnEventBySession.set(sessionId, onEvent);
      try {
        await runAgent(text, prepared.cleanHistory, {
          apiKey: prepared.apiKey,
          model: prepared.model,
          provider: prepared.provider as AgentOptions["provider"],
          baseURL: prepared.customBaseURL,
          systemPrompt: voiceSystemPrompt,
          tools: voiceTools,
          security, toolPolicy, rbac,
          sessionId,
          // 2 iterations when visuals are on: 1 for the optional voice_visual
          // tool call, 1 for the spoken reply continuation. The cooldown +
          // per-turn cap inside the tool prevents runaway loops.
          maxIterations: visualsEnabled ? 2 : 1,
          temperature: prepared.temperature,
          signal,
          onEvent,
        });
      } finally {
        // Restore prior onEvent registration (if any) so we don't leak.
        if (hadPrev && prev) activeOnEventBySession.set(sessionId, prev);
        else activeOnEventBySession.delete(sessionId);
      }

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
    const _imgCount = (attachments || []).filter((a: any) => a?.isImage).length;
    logger.info(`[ws-chat] onChat sess=${sessionId} msg_len=${message.length} atts=${(attachments || []).length} imgs=${_imgCount}`);
    // Canonical-chat decision lives inside /api/chat now (after
    // prepareAgentRequest, where the prepared payload is available). The WS
    // forward layer just transports — it doesn't route.
    try {
      const body = JSON.stringify({ message, sessionId, attachments: attachments || [] });
      logger.info(`[ws-chat] body_bytes=${body.length} → fetch /api/chat`);
      // 30 min cap on the WS-forward HTTP self-loop. Earlier 10 min was
      // truncating productive Opus + tool turns mid-flight (the model
      // would still be making real tool calls, but the UI's SSE stream
      // got cut). 30 min covers realistic agentic chat without becoming
      // an infinite-hang risk — true stalls are caught by the per-adapter
      // idle-event detector (LAX_CANONICAL_IDLE_TIMEOUT_MS, 120s default).
      // Long-term, this whole fetch hop should be replaced by direct
      // canonical-op subscription so connection drops become invisible
      // (UI calls reconnectOp on the opId after disconnect).
      const res = await fetch(`http://127.0.0.1:${config.port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.authToken}` },
        body,
        signal: AbortSignal.timeout(1_800_000),
      });
      logger.info(`[ws-chat] /api/chat status=${res.status} hasBody=${!!res.body}`);
      if (res.body) { for await (const _ of res.body) { /* drain */ } }
      logger.info(`[ws-chat] /api/chat drain complete sess=${sessionId}`);
    } catch (e) {
      const msg = (e as Error).message;
      logger.warn(`[ws-chat] Error:`, msg);
      // Tell the WS client the turn failed. Without this, the client's
      // activeChats entry stays {done:false} until the 5-minute cleanup
      // sweep — UI shows a spinner and accepts no new input until then.
      const isTimeout = msg.includes("timeout") || msg.includes("aborted");
      const reason = isTimeout
        ? "Chat timed out (no response after 10 minutes)."
        : `Chat transport error: ${msg}`;
      chatWs.failChat(sessionId, reason);
    }
  });
}

export function startConfigWatcher(dataDir: string): void {
  new ConfigWatcher().start(join(dataDir, "config.json"), () => logger.info("[config] Hot-reloaded"));
}

export function logStartup(deps: { config: LAXConfig; dataDir: string }): void {
  const { config, dataDir } = deps;
  const masked = config.authToken ? config.authToken.slice(0, 4) + "****" + config.authToken.slice(-4) : "none";
  logger.info(`\n  Local Agent X running at http://127.0.0.1:${config.port}\n  Auth token: ${masked}`);
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
