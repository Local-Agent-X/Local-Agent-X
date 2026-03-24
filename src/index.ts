// ── Persistent file logger ──
// Mirrors all console output to ~/.sax/logs/server.log so logs survive restarts.
import { createWriteStream, mkdirSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const logDir = join(homedir(), ".sax", "logs");
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

// Rotate if log exceeds 5MB
const logPath = join(logDir, "server.log");
try {
  if (existsSync(logPath) && statSync(logPath).size > 5 * 1024 * 1024) {
    renameSync(logPath, join(logDir, "server.prev.log"));
  }
} catch {}

const logStream = createWriteStream(logPath, { flags: "a" });

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
process.on("uncaughtException", (err) => {
  console.error("[CRASH GUARD] Uncaught exception:", err.message);
  console.error(err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRASH GUARD] Unhandled rejection:", reason);
});

import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import { loadTokens } from "./auth.js";

console.log(`
  ╔═══════════════════════════════════╗
  ║       SECRET AGENT X  v0.1       ║
  ╚═══════════════════════════════════╝
`);

const config = loadConfig();

// Check auth status
const tokens = loadTokens();
if (!config.openaiApiKey && !tokens) {
  console.log("  No API key or OAuth tokens found.");
  console.log("  Set OPENAI_API_KEY in your environment, or");
  console.log("  use the dashboard to sign in with OpenAI OAuth.\n");
}

// Handle CLI args
const args = process.argv.slice(2);
if (args.includes("--login")) {
  const { startOAuthLogin } = await import("./auth.js");
  try {
    await startOAuthLogin();
    console.log("[auth] Login successful!");
  } catch (e) {
    console.error("[auth] Login failed:", (e as Error).message);
    process.exit(1);
  }
}

startServer(config);
