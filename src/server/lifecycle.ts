import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { getLaxDir } from "../lax-data-dir.js";
import { join } from "node:path";
import { setupChatWebSocket } from "../chat-ws/index.js";
import { runSecurityAudit, printAuditReport } from "../security/security-audit.js";
import { startAriKernel } from "../ari-kernel/index.js";
import { EventBus } from "../event-bus.js";
import { ConfigWatcher } from "../config-hot-reload.js";
import { getRuntimeConfig, loadConfig, setRuntimeConfig } from "../config.js";
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

// SV-2 boot-window fallback: between initLifecycle (pidfile) and
// registerShutdown (the graceful owner), the only signal listeners are
// src/index.ts's non-exiting log-flush hooks — and ANY listener suppresses
// Node's default terminate. Without a fallback, Ctrl+C/SIGTERM during boot
// (a wedged rag build, a pending --login OAuth flow) is swallowed: the process
// survives everything short of SIGKILL, holds ~/.lax/server.pid, and every
// later launch refuses with exit 75. These exit with the conventional
// 128+signal codes exactly like the pre-SV-2 hard-exit handlers did;
// registerShutdown removes them the moment the graceful owner takes over.
// They live HERE (not src/lifecycle.ts) because this module is the one
// sanctioned signal-exit owner (see the SV-2 class-lock in lifecycle.test.ts).
const bootSigint = (): never => process.exit(130);
const bootSigterm = (): never => process.exit(143);

export function installBootSignalFallback(): void {
  process.on("SIGINT", bootSigint);
  process.on("SIGTERM", bootSigterm);
}

export function createHttpServer(requestHandler: RequestHandler, deps: {
  config: LAXConfig;
  dataDir: string;
}): LifecycleResult {
  const { config, dataDir } = deps;
  const server = createServer(requestHandler);
  // Migrations run as an awaited boot phase in startServer() BEFORE listen and
  // before startConfigWatcher — see server/index.ts. Firing them here
  // (fire-and-forget) raced the config watcher: a migration rewriting
  // config.json could be read mid-write by the watcher's loadConfig().
  const chatWs = setupChatWebSocket(server, config.authToken, config.maxUploadBytes);
  installUpgradeReaper(server);
  return { server, chatWs };
}

// Known WS endpoints. Each owning handler claims its own path via handleUpgrade;
// this terminal listener destroys upgrade sockets for any OTHER path so an
// unmatched upgrade can't sit half-open. Every `server.on("upgrade")` listener
// fires for every upgrade, so this only acts on paths no real handler owns —
// without it, chat-ws and voice-ws each silently `return` on a foreign path and
// the socket leaks (unauthenticated connection-exhaustion DoS).
const KNOWN_WS_PATHS = new Set(["/ws/chat", "/ws/voice"]);
function installUpgradeReaper(server: Server): void {
  server.on("upgrade", (req, socket) => {
    try {
      const u = new URL(req.url || "/", "http://localhost");
      if (KNOWN_WS_PATHS.has(u.pathname)) return; // owned by a real handler
    } catch { /* fall through to destroy a malformed upgrade */ }
    try { socket.destroy(); } catch { /* already gone */ }
  });
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
      const previousBrowserMode = getRuntimeConfig().browserMode;
      const nextConfig = loadConfig();
      setRuntimeConfig(nextConfig);
      if (nextConfig.browserMode !== previousBrowserMode) {
        void closeAllBrowsers();
      }
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

/**
 * Build the clickable "Open" line for stdout. BOTH the OSC-8 hyperlink target
 * and the visible text are token-less — the live token never enters stdout, so
 * it can't leak into terminal scrollback, a `tee`/CI capture, a process
 * supervisor's log, or a pasted bug report. The full one-click URL lives only
 * in the 0600 `.startup-url` file, whose path we point the user at. Closes the
 * R6-A4 trap where the line looked masked (`?token=****`) but the hyperlink
 * underneath carried the live token. (Desktop users are unaffected — the app
 * builds its own authenticated URL from config and never reads stdout.)
 */
export function buildOpenLine(port: number, startupUrlPath: string): string {
  const baseUrl = `http://127.0.0.1:${port}/`;
  return `  ► Open: \x1b]8;;${baseUrl}\x1b\\${baseUrl}\x1b]8;;\x1b\\  (one-click sign-in URL saved to ${startupUrlPath})`;
}

export function logStartup(deps: { config: LAXConfig; dataDir: string }): void {
  const { config, dataDir } = deps;
  const masked = config.authToken ? config.authToken.slice(0, 4) + "****" + config.authToken.slice(-4) : "none";
  logger.info(`\n  Local Agent X running at http://127.0.0.1:${config.port}\n  Auth token: ${masked}`);
  const realUrl = `http://127.0.0.1:${config.port}/?token=${config.authToken}`;
  const startupUrlPath = join(dataDir, ".startup-url");
  writeFileSync(startupUrlPath, realUrl, { mode: 0o600 });
  logger.info(`\n${buildOpenLine(config.port, startupUrlPath)}\n  Memory: ${dataDir}/memory/\n  Sessions: ${dataDir}/sessions/`);
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

  // Kill mcp-bridge subprocesses orphaned by a previous server lifetime. The
  // Claude CLI spawns them via our --mcp-config; on Windows a wrapper-only
  // teardown leaves them reparented and alive, and they accumulate across
  // launches until they wedge the next boot. Scoped to this install's bridge
  // path and to processes older than this server, so the warm pool's own
  // fresh bridges are spared. Fire-and-forget, non-fatal.
  try {
    void import("../reap-stale-procs.js").then(({ cleanupStaleMcpBridges }) =>
      cleanupStaleMcpBridges(),
    ).catch((e) => logger.warn(`[mcp-cleanup] failed: ${(e as Error).message}`));
  } catch (e) {
    logger.warn(`[mcp-cleanup] init failed: ${(e as Error).message}`);
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
  // Guard against re-entry: a second Ctrl+C (or a SIGTERM racing a SIGINT)
  // must not restart the async cleanup half-way through.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    getScheduler()?.stopAll();
    cronService.stop();
    // Kill any running full-stack app backends so they don't orphan past LAX
    // (they're spawned detached, so without this they'd survive and hold ports).
    try { const { stopAllDevServers } = await import("../tools/dev-server.js"); stopAllDevServers(); } catch { /* none running */ }
    try {
      const { WatchdogService } = await import("../agents/watchdog.js");
      WatchdogService.getInstance().stop();
    } catch { /* watchdog may never have started */ }
    try {
      const { stopBrokerPresence } = await import("../broker-transport/account/runtime.js");
      stopBrokerPresence();
    } catch { /* broker presence may never have started (tailnet path) */ }
    agentSync.stopHeartbeat();
    EventBus.removeAllListeners();
    await agentSync.push().catch(() => {});
    await closeAllBrowsers();
    // Drain any in-flight end-of-turn memory extraction before the index
    // closes under it. Bounded — shutdown must never hang on a slow LLM call.
    try {
      const { drainPendingExtractions } = await import("../memory/extraction-coalescer.js");
      await drainPendingExtractions(3000);
    } catch { /* best-effort — never block shutdown */ }
    memoryIndex.close();
    secretsStore.destroy();
    try { const { cleanupAllWorktrees } = await import("../agency/worktree.js"); cleanupAllWorktrees(); } catch {}
    process.exit(0);
  };
  // Graceful teardown must run on BOTH interactive Ctrl+C (SIGINT) and
  // supervisor/`kill` termination (SIGTERM). This is the ONLY module allowed
  // to call process.exit from a SIGINT/SIGTERM handler (SV-2 invariant,
  // enforced by lifecycle.test.ts): Node runs signal listeners synchronously
  // in registration order, so any sibling handler that exits synchronously
  // would preempt this cleanup the moment it suspends at its first `await`.
  // Other modules hook the signal-agnostic 'exit' event (fired by the
  // process.exit(0) above) for their synchronous cleanup instead — see
  // src/lifecycle.ts (pidfile) and src/autopilot/lock.ts (autopilot lock).
  // The graceful owner is live — retire the boot-window hard-exit fallback,
  // which would otherwise preempt the async cleanup exactly like the
  // pre-SV-2 handlers this module replaced.
  process.removeListener("SIGINT", bootSigint);
  process.removeListener("SIGTERM", bootSigterm);
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}
