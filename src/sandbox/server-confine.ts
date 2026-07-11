// Whole-server kernel confinement (red-team round-5 phase B).
//
// Phase A (seatbelt.ts / bwrap.ts shell scope) confines agent shell children;
// the Node server itself — the actual TCB — stayed unconfined. This module
// closes that gap by re-exec'ing the WHOLE server under the platform kernel
// sandbox at boot: the entry point calls maybeReexecServerConfined() before
// any subsystem loads; when confinement is enabled and usable, the process
// becomes an inert launcher that spawns `sandbox-exec -p <server profile>
// node <same argv>` (macOS) or `bwrap <server args> node <same argv>` (Linux)
// and only proxies the child's stdio, signals, and exit code. The confined
// child sees LAX_SERVER_CONFINED=1 and boots normally.
//
// Server scope is a TARGETED deny like phase A, not a hermetic jail: network
// stays allowed (the in-process egress chokepoint governs destinations) and
// the dirs the server owns (~/.lax, ~/.codex) are exempted — but even a fully
// compromised server process can no longer read ~/.ssh/~/.aws/etc. or write
// the persistence vectors, enforced by the kernel, and every child it spawns
// inherits the cage.
//
// Brick-risk escape hatch (the round-5 report's hard requirement): a confined
// boot that never reaches "listening" must not loop forever (the Node-floor
// incident showed desktop boot failures loop). The launcher records each
// attempt in <laxDir>/server-sandbox-boot.json; the listen callback calls
// markServerSandboxHealthy() to reset it. After MAX_CONSECUTIVE_FAILURES
// attempts that never went healthy, the launcher boots UNCONFINED with a loud
// error. Setting LAX_SERVER_SANDBOX=1 explicitly always retries.
//
// Off by default. Enable with config.json `"serverSandbox": true` or
// LAX_SERVER_SANDBOX=1. NOTE: this module must stay import-light — it runs in
// the launcher before the boot imports (config.ts and the server graph behind
// it) are allowed to load, so it reads config.json raw instead of via
// loadConfig(). config.ts imports are pure now (side effects moved to
// initConfig()), but keep this module lean anyway: the launcher should load
// nothing it doesn't need.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../logger.js";
import { getLaxDir } from "../lax-data-dir.js";
import { isSeatbeltAvailable, generateSeatbeltProfile, seatbeltProfileLoads, SANDBOX_EXEC } from "./seatbelt.js";
import { isBwrapAvailable, generateBwrapArgs, bwrapServerCageRuns } from "./bwrap.js";

const logger = createLogger("sandbox.server");

const MAX_CONSECUTIVE_FAILURES = 2;

interface BootMarker {
  state: "attempting" | "healthy";
  failures: number;
  updatedAt: string;
}

function markerPath(): string {
  return join(getLaxDir(), "server-sandbox-boot.json");
}

export function readBootMarker(): BootMarker | null {
  try {
    const raw = JSON.parse(readFileSync(markerPath(), "utf-8")) as Partial<BootMarker>;
    if (raw.state !== "attempting" && raw.state !== "healthy") return null;
    return {
      state: raw.state,
      failures: Number.isInteger(raw.failures) && (raw.failures as number) >= 0 ? (raw.failures as number) : 0,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
  } catch {
    return null;
  }
}

export function writeBootMarker(marker: BootMarker): void {
  try {
    mkdirSync(getLaxDir(), { recursive: true, mode: 0o700 });
    writeFileSync(markerPath(), JSON.stringify(marker, null, 2) + "\n");
  } catch (e) {
    logger.warn(`[server-sandbox] could not write boot marker: ${(e as Error).message}`);
  }
}

/** True inside the confined child (set by the launcher's spawn env). */
export function isServerConfined(): boolean {
  return process.env.LAX_SERVER_CONFINED === "1";
}

/**
 * Resolve whether server confinement is enabled. Env wins over config;
 * `explicit` marks an env opt-in, which bypasses the escape-hatch trip so an
 * operator can force a retry after fixing the cause. Reads config.json raw —
 * see the module header for why loadConfig() is off-limits here.
 */
export function serverSandboxSetting(): { enabled: boolean; explicit: boolean } {
  const env = (process.env.LAX_SERVER_SANDBOX ?? "").toLowerCase();
  if (env === "1" || env === "true" || env === "on") return { enabled: true, explicit: true };
  if (env === "0" || env === "false" || env === "off" || env === "none") return { enabled: false, explicit: true };
  try {
    const raw = JSON.parse(readFileSync(join(getLaxDir(), "config.json"), "utf-8")) as { serverSandbox?: unknown };
    return { enabled: raw.serverSandbox === true, explicit: false };
  } catch {
    return { enabled: false, explicit: false };
  }
}

/**
 * Called from the server's listen callback. A confined boot that binds its
 * port is proven non-bricking — reset the escape-hatch counter so future
 * boots keep confining. No-op in unconfined processes so a fallback boot
 * can't accidentally clear the trip evidence.
 */
export function markServerSandboxHealthy(): void {
  if (!isServerConfined()) return;
  writeBootMarker({ state: "healthy", failures: 0, updatedAt: new Date().toISOString() });
  logger.info("[server-sandbox] confined boot reached listening — escape-hatch counter reset");
}

/**
 * Entry-point gate. Returns true when this process re-exec'd a confined child
 * and must NOT continue booting (the caller suspends; exit happens via the
 * child-exit handler). Returns false when boot should proceed in THIS process
 * — either confinement is off/unusable (unconfined boot) or we ARE the
 * confined child.
 */
export function maybeReexecServerConfined(): boolean {
  if (isServerConfined()) {
    logger.info(`[server-sandbox] running kernel-confined (${process.platform === "darwin" ? "seatbelt" : "bwrap"})`);
    return false;
  }
  // The self_edit bind probe boots a worktree to test the CODE; wrapping it
  // would gate merges on cage health and double the probe's failure modes.
  if (process.env.LAX_SELF_EDIT_PROBE === "1") return false;

  const { enabled, explicit } = serverSandboxSetting();
  if (!enabled) return false;

  let cmd: string;
  let preArgs: string[];
  if (process.platform === "darwin") {
    if (!isSeatbeltAvailable() || !seatbeltProfileLoads(undefined, "server")) {
      logger.error("[server-sandbox] enabled but the seatbelt server profile does not load on this host — booting UNCONFINED.");
      return false;
    }
    cmd = SANDBOX_EXEC;
    preArgs = ["-p", generateSeatbeltProfile(undefined, "server")];
  } else if (process.platform === "linux") {
    if (!bwrapServerCageRuns()) {
      logger.error("[server-sandbox] enabled but bwrap is missing or the cage does not build on this kernel (unprivileged userns disabled?) — booting UNCONFINED.");
      return false;
    }
    cmd = "bwrap";
    preArgs = generateBwrapArgs(undefined, "server");
  } else {
    logger.error("[server-sandbox] enabled but no kernel sandbox exists for this platform (Windows is a documented gap) — booting UNCONFINED.");
    return false;
  }

  const marker = readBootMarker();
  const priorFailures = marker?.state === "attempting" ? marker.failures : 0;
  if (priorFailures >= MAX_CONSECUTIVE_FAILURES && !explicit) {
    logger.error(
      `[server-sandbox] ESCAPE HATCH TRIPPED: the last ${priorFailures} confined boots never reached listening — ` +
      "booting UNCONFINED so the app stays usable. Check ~/.lax/logs/server.log for the confined crash, " +
      "then force a retry with LAX_SERVER_SANDBOX=1 or by re-saving the setting.",
    );
    return false;
  }
  writeBootMarker({ state: "attempting", failures: priorFailures + 1, updatedAt: new Date().toISOString() });

  logger.info(`[server-sandbox] re-exec'ing the server under ${cmd} (attempt ${priorFailures + 1}, scope=server)`);
  const child = spawn(
    cmd,
    [...preArgs, process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, LAX_SERVER_CONFINED: "1" } },
  );
  child.on("error", (e) => {
    // Spawn itself failed (ENOENT etc.) — the marker already counts this
    // attempt, so a persistent failure trips the escape hatch in ≤2 boots.
    logger.error(`[server-sandbox] failed to spawn ${cmd}: ${e.message} — exiting so the supervisor restarts.`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => child.kill(sig));
  }
  return true;
}
