// ── Persistent file logger ──
// Mirrors all console output to ~/.lax/logs/server.log so logs survive restarts.
import { createWriteStream, mkdirSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";

import { createLogger } from "./logger.js";
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

import { loadConfig, setRuntimeConfig } from "./config.js";
import { startServer } from "./server/index.js";
import { loadTokens } from "./auth/index.js";
import { enforceStartupIntegrity } from "./startup-integrity.js";
import { initLifecycle } from "./lifecycle.js";

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

// Sweep orphaned self_edit/autopilot worktrees left in %TEMP%/lax-worktrees by
// a prior run that crashed before cleanup. Each can hold a live node_modules
// junction into the parent's real deps; we unlink those FIRST so a later
// `git worktree prune` / AV scan / temp cleanup can't traverse them and eat
// the parent node_modules (#11). Best-effort — must never block boot.
try {
  const { sweepOrphanWorktreeJunctions } = await import("./agency/worktree.js");
  sweepOrphanWorktreeJunctions();
} catch (e) {
  logger.warn(`[boot] orphan worktree sweep failed: ${(e as Error).message}`);
}

// Single-instance enforcement + pidfile + parent-pid heartbeat. Must run
// BEFORE startServer so we never bind ports while a sibling server is up.
initLifecycle();

logger.info(`
  ╔═══════════════════════════════════╗
  ║      LOCAL AGENT X  v0.1       ║
  ╚═══════════════════════════════════╝
`);

const config = loadConfig();

// One-time migration for installs that hit the silent-drift bug: if
// ~/.lax/settings.json has a runtime field (toolApproval, maxIterations,
// temperature, browserMode, bridgeVoicePreference) that differs from
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

startServer(config);
