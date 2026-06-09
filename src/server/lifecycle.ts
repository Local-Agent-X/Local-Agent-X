import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { getLaxDir } from "../lax-data-dir.js";
import { join } from "node:path";
import { setupChatWebSocket } from "../chat-ws/index.js";
import { runSecurityAudit, printAuditReport } from "../security/security-audit.js";
import { startAriKernel } from "../ari-kernel/index.js";
import { runMigrations } from "../db-migrations.js";
import { EventBus } from "../event-bus.js";
import { ConfigWatcher } from "../config-hot-reload.js";
import { loadConfig, setRuntimeConfig } from "../config.js";
import { closeAllBrowsers } from "../browser/index.js";
import type { LAXConfig } from "../types.js";
import type { MemoryIndex } from "../memory/index.js";
import type { SecretsStore } from "../secrets.js";
import type { CronService } from "../cron/cron-service.js";
import type { AgentSync } from "../sync/index.js";
import type { RequestHandler } from "./request-handler.js";
import { createLogger } from "../logger.js";
const logger = createLogger("server.lifecycle");

// Re-export for backward compatibility — server/index.ts imports it from here.
export { bootstrapCanonicalLoop } from "./canonical-loop-bootstrap.js";
export { setupVoiceWs } from "./voice-ws.js";

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

export function wireWsChat(deps: {
  chatWs: ReturnType<typeof setupChatWebSocket>;
  buildCtx: () => import("../server-context.js").ServerContext;
}): void {
  const { chatWs, buildCtx } = deps;
  chatWs.onChat(async (sessionId, message, attachments) => {
    const _imgCount = (attachments || []).filter((a: any) => a?.isImage).length;
    console.log(`[chat-diag] lifecycle onChat sess=${sessionId.slice(-8)} len=${message.length}`);
    logger.info(`[ws-chat] onChat sess=${sessionId} msg_len=${message.length} atts=${(attachments || []).length} imgs=${_imgCount} → direct (no HTTP self-loop)`);
    // Direct call into the same chat-turn logic the /api/chat route uses.
    // The previous implementation here did `fetch http://127.0.0.1:<port>/api/chat`
    // and drained the SSE body, paying the HTTP entry cost twice (TCP localhost,
    // headers, auth parse, lock acquire) on every WS chat. Events flow to the
    // browser via chat-ws's pub/sub (broadcastToSession), so the SSE side-channel
    // is unnecessary for WS callers — `sseSink: null` below. /api/chat remains
    // wired for non-WS callers (Telegram, WhatsApp, curl).
    //
    // Mark this session as "chat handler pending" for the inject handler:
    // runChatTurn does ~30-200ms of prep before the canonical op is created,
    // and an inject arriving in that window would otherwise see liveOps=[]
    // and get fresh-turn-routed instead of queued. The mark closes that
    // window so the inject lands in the queue and drainInjectsIntoTurn at
    // the top of driveTurn picks it up. See ops/session-bridge.ts.
    const { markChatHandlerPending, clearChatHandlerPending } = await import("../ops/session-bridge.js");
    markChatHandlerPending(sessionId);
    try {
      const { runChatTurn } = await import("../routes/chat/run-chat-turn.js");
      const ctx = buildCtx();
      // The WS frame's projectId was stamped onto the session map by
      // message-router.handleChat before this handler ran. Pass it through —
      // hardcoding null here cleared the binding and dropped project scope on
      // every WS spawn (agent_* ran on the global model, not the project's
      // per-project override).
      const { getSessionProject } = await import("../session/project.js");
      await runChatTurn({
        sessionId,
        message,
        // WS frame passes attachments through unverified (the WS handshake
        // already auth'd the client). The shape matches the HTTP schema —
        // [{name, url, isImage}] — but is typed `any[]` upstream in chat-ws.
        attachments: (attachments || []) as Array<{ name: string; url: string; isImage: boolean }>,
        projectId: getSessionProject(sessionId) ?? null,
        ctx,
        requestRole: "operator",
        sseSink: null,
      });
    } catch (e) {
      const msg = (e as Error).message;
      logger.warn(`[ws-chat] Error:`, msg);
      // Tell the WS client the turn failed. Without this, the client's
      // activeChats entry stays {done:false} until the 5-minute cleanup
      // sweep — UI shows a spinner and accepts no new input until then.
      chatWs.failChat(sessionId, `Chat error: ${msg}`);
    } finally {
      clearChatHandlerPending(sessionId);
    }
  });
}

export function startConfigWatcher(dataDir: string): void {
  // Reload from disk via loadConfig() so the freshly-validated LAXConfig (with
  // profile defaults, schema parse, generated authToken) is what gets handed
  // to setRuntimeConfig. Without this call, in-memory ctx.config stays stale
  // forever and a UI toggle (enableShell / toolApproval / etc.) writes to
  // config.json but the running gate keeps using the old value — observable
  // as "I turned shell OFF but bash still runs" until process restart.
  new ConfigWatcher().start(join(dataDir, "config.json"), () => {
    try {
      setRuntimeConfig(loadConfig());
      logger.info("[config] Hot-reloaded (runtime config updated)");
    } catch (e) {
      logger.warn(`[config] Hot-reload load failed: ${(e as Error).message}`);
    }
  });
}

// Start the AriKernel as a boot precondition. ARI is a primary security
// guardian; when ariRequired (the default), a kernel that fails to start
// must take the whole server down rather than let it serve unprotected —
// the tool gate fail-closes too, but the app should never be "on" with the
// guardian "off". Awaited before listen() so the socket never binds without it.
export async function startSecurityKernel(deps: { config: LAXConfig; dataDir: string }): Promise<void> {
  const { config, dataDir } = deps;
  const active = await startAriKernel(join(dataDir, "ari-audit.db"), undefined, config.ariRequired);
  if (active) {
    logger.info(`  [ari] Audit active`);
    return;
  }
  if (config.ariRequired) {
    logger.error(
      `  [ari] FATAL: AriKernel is required but failed to start. It is a primary security guardian — ` +
      `refusing to bring the server up without it. To debug a wedged kernel, set LAX_ARI_REQUIRED=false (unsafe).`,
    );
    process.exit(1);
  }
  logger.warn(`  [ari] Kernel inactive (LAX_ARI_REQUIRED=false) — gated tools fall back to the other defense layers.`);
}

export function logStartup(deps: { config: LAXConfig; dataDir: string }): void {
  const { config, dataDir } = deps;
  const masked = config.authToken ? config.authToken.slice(0, 4) + "****" + config.authToken.slice(-4) : "none";
  logger.info(`\n  Local Agent X running at http://127.0.0.1:${config.port}\n  Auth token: ${masked}`);
  const realUrl = `http://127.0.0.1:${config.port}/?token=${config.authToken}`;
  writeFileSync(join(dataDir, ".startup-url"), realUrl, { mode: 0o600 });
  logger.info(`\n  ► Open: \x1b]8;;${realUrl}\x1b\\http://127.0.0.1:${config.port}/?token=${masked}\x1b]8;;\x1b\\\n  Memory: ${dataDir}/memory/\n  Sessions: ${dataDir}/sessions/`);
  printAuditReport(runSecurityAudit({ authToken: config.authToken, workspace: config.workspace }));
  try { import("../auth/refresh.js").then(({ startAuthRefreshTimer }) => startAuthRefreshTimer()).catch(() => {}); } catch {}

  // Kill orphan Chrome processes from a previous server lifetime that still
  // hold the agent's user-data-dir (~/.lax/chrome-profile). Without this,
  // the next launchViaCDP call silently joins the dead process and the user
  // sees no browser window — observed today during the sample-app session
  // (14 Chrome processes with no MainWindowTitle). Fire-and-forget; only
  // kills processes whose --user-data-dir matches the agent profile
  // exactly. Never touches the user's regular Chrome.
  try {
    const agentProfile = join(getLaxDir(), "chrome-profile");
    void import("../browser/cleanup-stale.js").then(({ cleanupStaleAgentChrome }) =>
      cleanupStaleAgentChrome(agentProfile),
    ).catch((e) => logger.warn(`[browser-cleanup] failed: ${(e as Error).message}`));
  } catch (e) {
    logger.warn(`[browser-cleanup] init failed: ${(e as Error).message}`);
  }
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
    try {
      const { WatchdogService } = await import("../agents/watchdog.js");
      WatchdogService.getInstance().stop();
    } catch { /* watchdog may never have started */ }
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
