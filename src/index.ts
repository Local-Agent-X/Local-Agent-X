// ── Persistent file logger ──
// Mirrors all console output to ~/.lax/logs/server.log so logs survive restarts.
import { createWriteStream, mkdirSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";

import { createLogger } from "./logger.js";
import { installProbeSelfDestruct } from "./probe-self-destruct.js";
const logger = createLogger("index");

// Broken-pipe guard. Must be installed BEFORE any code writes to stdout/
// stderr. If the parent process (Electron, terminal, supervisor) closes
// its read end of our stdio, every console.log/error here throws EPIPE.
// Without these listeners, the EPIPE becomes an "uncaughtException", the
// crash guard below tries to log it via console.error, which writes to
// the same dead pipe and throws another EPIPE, which fires another
// uncaughtException — runaway recursion that wrote 2.5M log lines in 30s
// on 2026-05-19, ballooning server.log past 500MB and pinning CPU at 100%.
// Silently swallow EPIPE here; any other stream error still gets a single
// file-only log line so we don't hide real problems.
process.stderr.on("error", (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EPIPE") return;
  try { logStream.write(`[${new Date().toISOString()}] WARN stderr error: ${err.message}\n`); } catch {}
});
process.stdout.on("error", (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EPIPE") return;
  try { logStream.write(`[${new Date().toISOString()}] WARN stdout error: ${err.message}\n`); } catch {}
});

const logDir = join(getLaxDir(), "logs");
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true, mode: 0o700 });

// Rotate if log exceeds 5MB
const logPath = join(logDir, "server.log");
try {
  if (existsSync(logPath) && statSync(logPath).size > 5 * 1024 * 1024) {
    renameSync(logPath, join(logDir, "server.prev.log"));
  }
} catch {}

const logStream = createWriteStream(logPath, { flags: "a" });

// Close log stream on exit to flush pending writes
process.on("SIGINT", () => logStream.end());
process.on("SIGTERM", () => logStream.end());

function timestamp(): string {
  return new Date().toISOString();
}

const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

console.log = (...args: unknown[]) => {
  origLog(...args);
  logStream.write(`[${timestamp()}] ${args.map(String).join(" ")}\n`);
};
console.error = (...args: unknown[]) => {
  origError(...args);
  logStream.write(`[${timestamp()}] ERROR ${args.map(String).join(" ")}\n`);
};
console.warn = (...args: unknown[]) => {
  origWarn(...args);
  logStream.write(`[${timestamp()}] WARN ${args.map(String).join(" ")}\n`);
};

// Global crash guard — keep the server alive on unhandled errors
// EADDRINUSE is fatal: server can't function without a port, so exit
// instead of letting background services (Telegram, cron) keep the process alive as a zombie
process.on("uncaughtException", (err) => {
  // EPIPE on stdout/stderr — silently drop. logger.error would write to
  // the same dead pipe, throw another EPIPE, fire this handler again,
  // and loop forever. The stderr/stdout error listeners at the top of
  // this file should catch most cases; this is the second-line guard
  // for EPIPEs that surface from elsewhere (subprocess stdio, ws frame
  // writes during socket teardown, etc.).
  if ((err as NodeJS.ErrnoException).code === "EPIPE") {
    try { logStream.write(`[${timestamp()}] WARN [CRASH GUARD] suppressed EPIPE\n`); } catch {}
    return;
  }
  // Do NOT access err.stack synchronously here. The .stack getter triggers
  // V8's bytecode-source-position formatting for every frame, which can
  // pin the event loop at 100% CPU for minutes on deeply async errors
  // (we saw a real freeze where the original error message never even
  // got logged because the stack formatter starved everything else).
  // Capture a bounded slice via setImmediate so the formatter doesn't
  // run on the main thread.
  logger.error(`[CRASH GUARD] Uncaught exception: ${err.name}: ${err.message}`);
  setImmediate(() => {
    try {
      const stack = (err.stack ?? "").split("\n").slice(0, 25).join("\n");
      logger.error(stack);
    } catch { /* stack formatting itself can throw */ }
  });
  const fatal = (err as NodeJS.ErrnoException).code;
  if (fatal === "EADDRINUSE" || fatal === "EACCES") {
    logger.error("[CRASH GUARD] Fatal: cannot bind port — exiting");
    process.exit(1);
  }
});
process.on("unhandledRejection", (reason) => {
  // Same defensive treatment as uncaughtException — if `reason` is an
  // Error, don't access .stack on the main thread.
  const msg = reason instanceof Error
    ? `${reason.name}: ${reason.message}`
    : String(reason);
  logger.error(`[CRASH GUARD] Unhandled rejection: ${msg}`);
  if (reason instanceof Error) {
    setImmediate(() => {
      try {
        logger.error((reason.stack ?? "").split("\n").slice(0, 25).join("\n"));
      } catch { /* */ }
    });
  }
});

// ── Whole-server kernel confinement (round-5 phase B) ──
// When enabled, re-exec the entire server under seatbelt/bwrap and turn this
// process into an inert launcher that proxies the child's stdio/signals/exit.
// Must run before any subsystem import executes — config.ts starts file
// watchers at import time, which is why every boot import below is dynamic
// (static imports hoist and would run in the launcher too). The unresolved
// await suspends this module forever in the launcher; the child-exit handler
// inside maybeReexecServerConfined() calls process.exit.
const { maybeReexecServerConfined } = await import("./sandbox/server-confine.js");
if (maybeReexecServerConfined()) {
  await new Promise<never>(() => { /* launcher parks here until the confined child exits */ });
}

const { loadConfig, setRuntimeConfig } = await import("./config.js");
const { startServer } = await import("./server/index.js");
const { loadTokens } = await import("./auth/index.js");
const { enforceStartupIntegrity } = await import("./startup-integrity.js");
const { initLifecycle } = await import("./lifecycle.js");

// Fast-fail at boot if AV quarantine (or anything else) wiped tracked
// files. Prevents silent mid-conversation crashes when packages/arikernel
// gets eaten by Defender. Either passes silently or exits 2 with a clear
// remediation message. Must run BEFORE startServer.
enforceStartupIntegrity();

// One-time notice if a self_edit merged into main on a prior run. Gives the
// operator the revert escape hatch in case the merged code misbehaves at
// runtime (the post-merge re-gate only catches a broken build). Best-effort.
try {
  const { revertPendingMergeIfCrashed, surfaceUnacknowledgedMerge } = await import("./self-edit-rollback.js");
  // Crashed-merge guard FIRST: if a prior boot loaded a self_edit merge and
  // never bound, the merged code crashes on startup — auto-revert + rebuild so
  // this/next boot runs the last good code instead of bricking on every restart.
  const recovered = revertPendingMergeIfCrashed();
  if (recovered) logger.warn(`[boot] crashed self_edit merge auto-revert: ${recovered.detail}`);
  surfaceUnacknowledgedMerge();
} catch { /* best-effort */ }

// NOTE: the orphan-worktree sweep used to run HERE, before the server bound.
// It walks %TEMP%/lax-worktrees and recursive-deletes dead worktrees, retrying
// EBUSY dirs with backoff — which cost 11s+ of boot on a box where those dirs
// stay locked, all of it blocking port-listening. The sweep is pure best-effort
// cleanup with no ordering dependency on startup, so it now runs DETACHED after
// startServer (see bottom of file). Boot no longer waits on it.

// Single-instance enforcement + pidfile + parent-pid heartbeat. Must run
// BEFORE startServer so we never bind ports while a sibling server is up.
await initLifecycle();

// SV-2: until registerShutdown (server/lifecycle.ts) takes ownership of
// graceful shutdown, signals must still terminate the process — the log-flush
// hooks above are non-exiting listeners, which suppress Node's default
// terminate. The fallback hard-exits (130/143) during the boot window and is
// removed by registerShutdown at handoff.
const { installBootSignalFallback } = await import("./server/lifecycle.js");
installBootSignalFallback();

logger.info(`
  ╔═══════════════════════════════════╗
  ║      LOCAL AGENT X  v0.1       ║
  ╚═══════════════════════════════════╝
`);

const config = loadConfig();

// One-time migration for installs that hit the silent-drift bug: if
// ~/.lax/settings.json has a runtime field (toolApproval, maxIterations,
// temperature, bridgeVoicePreference) that differs from
// config.json, the settings.json value wins (that's what the user saw in
// the UI). Idempotent — after the first run config.json catches up and
// subsequent boots match on every field.
try {
  const { loadSettings } = await import("./settings.js");
  const settings = loadSettings();
  const { migrateRuntimeSettingsFromSettingsJson } = await import("./settings-schema.js");
  const { saveConfig } = await import("./config.js");
  if (migrateRuntimeSettingsFromSettingsJson(settings, config)) {
    saveConfig(config);
    logger.info("[config] Migrated runtime settings from settings.json to config.json (source-of-truth alignment)");
  }
} catch (e) {
  logger.warn(`[config] Runtime-settings migration skipped: ${(e as Error).message}`);
}

// One-time migration for upgrades: if the user had a legacy toolApproval
// setting but no autonomy-profile.json yet, map their old choice into the
// new five-profile vocabulary so they don't get surprised by the Normal
// default. Idempotent — once autonomy-profile.json exists this branch
// short-circuits.
try {
  const { existsSync } = await import("node:fs");
  const { PROFILE_STORE_PATH, saveProfileName } = await import("./autonomy/profile-store.js");
  if (!existsSync(PROFILE_STORE_PATH)) {
    const legacy = (config as { toolApproval?: string }).toolApproval;
    const mapped =
      legacy === "auto" ? "Power" :
      legacy === "confirm-risky" ? "Normal" :
      legacy === "confirm-all" ? "Safe" : null;
    if (mapped) {
      saveProfileName(mapped);
      logger.info(`[autonomy] Migrated legacy toolApproval="${legacy}" → profile="${mapped}"`);
    }
  }
} catch (e) {
  logger.warn(`[autonomy] Profile migration skipped: ${(e as Error).message}`);
}

setRuntimeConfig(config);

// Check auth status
const tokens = loadTokens();
if (!config.openaiApiKey && !tokens) {
  logger.info("  No API key or OAuth tokens found.");
  logger.info("  Set OPENAI_API_KEY in your environment, or");
  logger.info("  use the dashboard to sign in with OpenAI OAuth.\n");
}

// Handle CLI args
const args = process.argv.slice(2);
if (args.includes("--login")) {
  const { startOAuthLogin } = await import("./auth/index.js");
  try {
    await startOAuthLogin();
    logger.info("[auth] Login successful!");
  } catch (e) {
    logger.error("[auth] Login failed:", (e as Error).message);
    process.exit(1);
  }
}

// A rejected startServer means a boot phase failed: there is no listening
// socket and never will be. Without this catch the rejection fell into the
// crash guard above, which logs and keeps the process alive — a zombie that
// holds server.pid while the desktop splash polls /api/health forever
// (2026-06-09: a stale-dist import error produced exactly that hang). Exit
// loudly instead so the desktop shell's exit handler can restart or surface
// recovery. logStream.end flushes the log first; the timer is the backstop
// in case the stream callback never fires.
startServer(config).catch((e: Error) => {
  logger.error(`[boot] startServer failed — exiting: ${e.message}`);
  logStream.end(() => process.exit(1));
  setTimeout(() => process.exit(1), 2000);
});

// Deferred orphan-worktree sweep — runs AFTER the server is up so its
// filesystem walk + EBUSY-retry deletes never block port-listening. Best-effort
// cleanup of dead self_edit/autopilot worktrees in %TEMP%/lax-worktrees; each
// can hold a node_modules junction into the parent's real deps, so it unlinks
// those reparse points before any recursive delete (see sweepOrphanWorktreeJunctions).
//
// NEVER in a self_edit bind probe: the probe boots from a worktree INSIDE
// %TEMP%/lax-worktrees, so the sweep would unlink the junction it's booting on
// and kill itself mid-probe. Only the real server sweeps.
if (process.env.LAX_SELF_EDIT_PROBE !== "1") {
  setTimeout(() => {
    void (async () => {
      try {
        const { sweepOrphanWorktreeJunctions } = await import("./agency/worktree.js");
        await sweepOrphanWorktreeJunctions();
      } catch (e) {
        logger.warn(`[boot] deferred orphan worktree sweep failed: ${(e as Error).message}`);
      }
    })();
  }, 5000);

  // Deferred orphan-sidecar reap. Voice GPU sidecars are spawned detached so
  // they survive a tsx hot-reload, which means one that hangs (crashes its
  // HTTP server but doesn't exit) escapes killTier's port reaper and piles up
  // across restarts. Sweep once at boot to clear the accumulated pile, then
  // every 60s to auto-kill mid-session crashes. The running-map guard inside
  // reapOrphanSidecars means a sidecar this instance owns (incl. cold start)
  // is never touched. Off the boot path so the PowerShell scan never blocks
  // port-listening.
  setTimeout(() => {
    void (async () => {
      try {
        const { reapOrphanSidecars } = await import("./routes/bridges/voice-setup/process-control.js");
        const n = await reapOrphanSidecars();
        if (n > 0) logger.info(`[boot] reaped ${n} orphan voice sidecar(s)`);
        setInterval(() => { void reapOrphanSidecars().catch(() => {}); }, 60_000).unref();
      } catch (e) {
        logger.warn(`[boot] orphan sidecar reap failed: ${(e as Error).message}`);
      }
    })();
  }, 6000);
} else {
  // A bind probe must end itself: killProbe in the gate's finally only runs if
  // the gate-runner survives, and a force-killed/crashed runner orphans the
  // probe forever (Windows never reaps it), holding loaded native modules and
  // blocking the next npm ci. No external reaper sees an isolated-data-dir
  // probe, so it self-limits — parent-death watchdog + 10min backstop (the gate
  // BIND/BUILD timeout is 5min, so a live-at-10min probe is provably orphaned).
  installProbeSelfDestruct({
    parentPid: Number(process.env.LAX_PROBE_PARENT_PID),
    maxLifetimeMs: 10 * 60_000,
  });
}
