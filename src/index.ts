// ── Persistent file logger ──
// Mirrors all console output to ~/.lax/logs/server.log so logs survive restarts.
import { createWriteStream, mkdirSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { createLogger } from "./logger.js";
const logger = createLogger("index");

function migrateLegacyDataDir(): void {
  const newDir = join(homedir(), ".lax");
  const oldDir = join(homedir(), ".sax");
  if (existsSync(newDir) && existsSync(oldDir)) {
    process.stderr.write(
      `[migrate] FATAL: both ~/.sax and ~/.lax exist — refusing to start.\n` +
      `[migrate] A previous migration attempt likely failed mid-rename.\n` +
      `[migrate] Inspect both dirs and remove the empty/stale one before restarting.\n`
    );
    process.exit(1);
  }
  if (!existsSync(newDir) && existsSync(oldDir)) {
    try {
      renameSync(oldDir, newDir);
      process.stdout.write("[migrate] Renamed ~/.sax → ~/.lax\n");
    } catch (e) {
      process.stderr.write(
        `[migrate] FATAL: could not rename ~/.sax → ~/.lax: ${(e as Error).message}\n` +
        `[migrate] Likely cause: another process holds files in ~/.sax open.\n` +
        `[migrate] Stop any running agent process, then restart.\n`
      );
      process.exit(1);
    }
  }
}
migrateLegacyDataDir();

const logDir = join(homedir(), ".lax", "logs");
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
  logger.error("[CRASH GUARD] Uncaught exception:", err.message);
  logger.error(err.stack ?? "");
  const fatal = (err as NodeJS.ErrnoException).code;
  if (fatal === "EADDRINUSE" || fatal === "EACCES") {
    logger.error("[CRASH GUARD] Fatal: cannot bind port — exiting");
    process.exit(1);
  }
});
process.on("unhandledRejection", (reason) => {
  logger.error("[CRASH GUARD] Unhandled rejection:", reason);
});

import { loadConfig, setRuntimeConfig } from "./config.js";
import { startServer } from "./server.js";
import { loadTokens } from "./auth.js";
import { enforceStartupIntegrity } from "./startup-integrity.js";

// Fast-fail at boot if AV quarantine (or anything else) wiped tracked
// files. Prevents silent mid-conversation crashes when packages/arikernel
// gets eaten by Defender. Either passes silently or exits 2 with a clear
// remediation message. Must run BEFORE startServer.
enforceStartupIntegrity();

logger.info(`
  ╔═══════════════════════════════════╗
  ║      LOCAL AGENT X  v0.1       ║
  ╚═══════════════════════════════════╝
`);

const config = loadConfig();
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
  const { startOAuthLogin } = await import("./auth.js");
  try {
    await startOAuthLogin();
    logger.info("[auth] Login successful!");
  } catch (e) {
    logger.error("[auth] Login failed:", (e as Error).message);
    process.exit(1);
  }
}

startServer(config);
