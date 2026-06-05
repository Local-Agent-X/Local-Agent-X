#!/usr/bin/env node
/**
 * Process supervisor for Local Agent X.
 *
 * Wraps the dev:nowatch server in a parent watchdog that:
 *   - auto-restarts on crash (with exponential backoff up to MAX_RESTART_ATTEMPTS)
 *   - probes /api/health every PROBE_INTERVAL_MS
 *   - kills + recycles the child if it stops responding for HEALTH_TIMEOUT_MS
 *   - kills + recycles if heap usage exceeds HEAP_PRESSURE_RATIO of the limit
 *   - forwards SIGINT/SIGTERM to the child and waits for clean exit
 *
 * Usage: npm run dev:supervised
 *   (or: node scripts/supervisor.mjs)
 *
 * The child is the same dev:nowatch invocation, just under a supervisor that
 * keeps it alive. From the user's perspective, the server "never goes down" —
 * crashes get a 3-5s reconnect, hangs get force-recycled within 60s.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// ── Tunables (env-overridable) ─────────────────────────────────────────────

const PORT = parseInt(process.env.LAX_PORT || "7007", 10);
const HEAP_LIMIT_MB = parseInt(process.env.LAX_HEAP_LIMIT_MB || "4096", 10);
const HEAP_PRESSURE_RATIO = parseFloat(process.env.LAX_HEAP_PRESSURE_RATIO || "0.85");
const PROBE_INTERVAL_MS = parseInt(process.env.LAX_PROBE_INTERVAL_MS || "30000", 10);
const HEALTH_TIMEOUT_MS = parseInt(process.env.LAX_HEALTH_TIMEOUT_MS || "60000", 10);
const STARTUP_GRACE_MS = parseInt(process.env.LAX_STARTUP_GRACE_MS || "60000", 10);
const MAX_RESTART_ATTEMPTS = parseInt(process.env.LAX_MAX_RESTART_ATTEMPTS || "20", 10);
const RESTART_WINDOW_MS = parseInt(process.env.LAX_RESTART_WINDOW_MS || "300000", 10); // 5 min

// ── Auth token: read from existing config so probes can hit the auth-gated endpoint ──

function readAuthToken() {
  const cfgPath = join(homedir(), ".lax", "config.json");
  if (!existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    return cfg.authToken || null;
  } catch {
    return null;
  }
}

// ── State ─────────────────────────────────────────────────────────────────

let child = null;
let probeTimer = null;
let restartHistory = [];     // timestamps of restarts within window
let killedByUs = false;      // distinguish our recycle from external SIGKILL
let shuttingDown = false;
let lastHealthOk = Date.now();

function log(level, msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[supervisor ${level}] ${ts} ${msg}\n`);
}

// ── Health probe ───────────────────────────────────────────────────────────

async function probeHealth(authToken) {
  try {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // Endpoint missing or auth failure — fall back to /api/auth/status which
      // exists but is auth-exempt for the status check. Treat that as "alive".
      const fallback = await fetch(`http://127.0.0.1:${PORT}/api/auth/status`, {
        signal: AbortSignal.timeout(5000),
      });
      if (fallback.ok || fallback.status === 401) {
        return { alive: true, heapMb: null, uptimeS: null };
      }
      return { alive: false, reason: `health probe HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => null);
    return {
      alive: true,
      heapMb: body?.heap?.usedMb ?? null,
      heapLimitMb: body?.heap?.limitMb ?? null,
      uptimeS: body?.uptimeS ?? null,
    };
  } catch (e) {
    return { alive: false, reason: e?.message || String(e) };
  }
}

async function startProbeLoop() {
  const authToken = readAuthToken();
  if (probeTimer) clearInterval(probeTimer);
  probeTimer = setInterval(async () => {
    if (!child || shuttingDown) return;
    const result = await probeHealth(authToken);
    if (result.alive) {
      lastHealthOk = Date.now();
      // Heap pressure check — recycle proactively before OOM
      if (result.heapMb && result.heapLimitMb) {
        const ratio = result.heapMb / result.heapLimitMb;
        if (ratio > HEAP_PRESSURE_RATIO) {
          log("warn", `heap pressure ${(ratio * 100).toFixed(0)}% (${result.heapMb}MB / ${result.heapLimitMb}MB) — force-recycle`);
          recycleChild("heap-pressure");
        }
      }
    } else {
      const elapsed = Date.now() - lastHealthOk;
      if (elapsed > HEALTH_TIMEOUT_MS) {
        log("warn", `health probe failed for ${(elapsed / 1000).toFixed(0)}s (${result.reason}) — force-recycle`);
        recycleChild("health-timeout");
      }
    }
  }, PROBE_INTERVAL_MS);
}

// ── Child lifecycle ────────────────────────────────────────────────────────

function spawnChild() {
  log("info", `spawning server (heap=${HEAP_LIMIT_MB}MB, port=${PORT})`);
  killedByUs = false;
  lastHealthOk = Date.now() + STARTUP_GRACE_MS; // grace period before health checks count

  const env = { ...process.env, LAX_HEAP_LIMIT_MB: String(HEAP_LIMIT_MB) };
  const args = [`--max-old-space-size=${HEAP_LIMIT_MB}`, "--import=tsx", "src/index.ts"];

  child = spawn("node", args, {
    cwd: process.cwd(),
    stdio: "inherit",  // child output passes through to wherever the supervisor was launched
    env,
    shell: false,
    windowsHide: true,
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      log("info", `child exited (code=${code} signal=${signal}) during shutdown`);
      return;
    }
    if (killedByUs) {
      log("info", `child recycled (code=${code} signal=${signal}) — restarting`);
    } else {
      log("warn", `child exited unexpectedly (code=${code} signal=${signal}) — restarting`);
    }
    scheduleRestart();
  });

  child.on("error", (e) => {
    log("error", `child spawn error: ${e.message}`);
  });
}

function recycleChild(reason) {
  if (!child || killedByUs) return;
  killedByUs = true;
  log("info", `recycling child (reason=${reason})`);
  // SIGTERM first; if it doesn't exit in 5s, SIGKILL
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    if (child && child.exitCode === null && child.signalCode === null) {
      log("warn", `child did not exit on SIGTERM after 5s — SIGKILL`);
      try { child.kill("SIGKILL"); } catch {}
      // On Windows, kill the process tree
      if (process.platform === "win32" && child.pid) {
        try {
          spawn("taskkill", ["/PID", String(child.pid), "/F", "/T"], { stdio: "ignore", windowsHide: true });
        } catch {}
      }
    }
  }, 5000);
}

function scheduleRestart() {
  child = null;
  // Trim history to current window
  const now = Date.now();
  restartHistory = restartHistory.filter(t => now - t < RESTART_WINDOW_MS);
  restartHistory.push(now);

  if (restartHistory.length > MAX_RESTART_ATTEMPTS) {
    log("error", `${restartHistory.length} restarts in last ${RESTART_WINDOW_MS / 1000}s — giving up. Likely persistent failure; check logs.`);
    process.exit(1);
  }

  // Exponential backoff capped at 30s
  const attempts = restartHistory.length;
  const delayMs = Math.min(1000 * Math.pow(2, Math.min(attempts - 1, 5)), 30000);
  log("info", `restart in ${delayMs}ms (attempt ${attempts}/${MAX_RESTART_ATTEMPTS} in last ${RESTART_WINDOW_MS / 1000}s)`);
  setTimeout(() => {
    spawnChild();
  }, delayMs);
}

// ── Signal forwarding ──────────────────────────────────────────────────────

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", `received ${signal} — shutting down`);
  if (probeTimer) clearInterval(probeTimer);
  if (child) {
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      if (child && child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Boot ───────────────────────────────────────────────────────────────────

log("info", "Local Agent X process supervisor starting");
log("info", `heap=${HEAP_LIMIT_MB}MB, probe every ${PROBE_INTERVAL_MS / 1000}s, recycle on heap>${(HEAP_PRESSURE_RATIO * 100).toFixed(0)}% or health-fail>${HEALTH_TIMEOUT_MS / 1000}s`);
spawnChild();
startProbeLoop();
