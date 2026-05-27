// Server lifecycle binding — keeps the server tied to whatever spawned it
// (Electron, supervisor, npm run dev) so orphans don't accumulate after
// abnormal parent exits.
//
// Three jobs:
//   1. Single-instance enforcement. If another LAX server already owns
//      the pidfile and is alive, refuse to boot (the launcher should kill
//      it first; see desktop/src/main.ts handshake).
//   2. Pidfile so the launcher can identify whether the server on the port
//      is the one it spawned (matches parentPid in the file) or a stale
//      orphan (parentPid mismatch) that needs to be killed and replaced.
//   3. Heartbeat. When LAX_PARENT_PID is set, poll every 5s; if the parent
//      process died, exit voluntarily so the next launch starts clean.
//
// OS-level guarantees (Job Object on Windows, default in libuv) handle the
// common case where the parent dies cleanly. This module is the recovery
// layer for the cases libuv misses (force-kill, power-off-then-stale-file,
// foreign-launcher).

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";

import { createLogger } from "./logger.js";
import { isPidAlive, isOurServerProcess } from "./pid-probe.js";

const logger = createLogger("lifecycle");

const LAX_DIR = getLaxDir();
const PIDFILE = join(LAX_DIR, "server.pid");
const HEARTBEAT_MS = 5_000;

interface PidFile {
  pid: number;
  parentPid?: number;
  startedAt: string;
}

function readPidFile(): PidFile | null {
  if (!existsSync(PIDFILE)) return null;
  try {
    return JSON.parse(readFileSync(PIDFILE, "utf-8")) as PidFile;
  } catch {
    return null;
  }
}

function writePidFile(parentPid: number | undefined): void {
  if (!existsSync(LAX_DIR)) mkdirSync(LAX_DIR, { recursive: true, mode: 0o700 });
  const payload: PidFile = {
    pid: process.pid,
    parentPid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(PIDFILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

function removePidFile(): void {
  try {
    // Only delete if it still names us — a launcher that killed us may have
    // already written a fresh pidfile for its replacement server.
    const f = readPidFile();
    if (f && f.pid === process.pid) unlinkSync(PIDFILE);
  } catch {}
}

export function initLifecycle(): void {
  // Single-instance check. A stale pidfile (PID dead OR recycled to a
  // non-node process — happens routinely on Windows after a reboot) is
  // harmless: we delete it and overwrite below. A live foreign node
  // process means a previous server is still running; refuse to start so
  // we don't double-bind ports or fight over the audit DB.
  const existing = readPidFile();
  if (existing && existing.pid !== process.pid) {
    if (isOurServerProcess(existing.pid)) {
      logger.error(
        `[lifecycle] Refusing to start — server already running (pid ${existing.pid}, ` +
        `started ${existing.startedAt}). The launcher should kill it before respawning.`,
      );
      process.exit(75); // EX_TEMPFAIL — recoverable, retry after kill
    }
    // Stale (PID dead or recycled). Drop the file so writePidFile() below
    // writes a clean one for us.
    try { unlinkSync(PIDFILE); } catch {}
  }

  const parentPidRaw = process.env.LAX_PARENT_PID;
  const parentPid = parentPidRaw ? Number(parentPidRaw) : undefined;
  writePidFile(parentPid);

  process.on("exit", removePidFile);
  process.on("SIGINT", () => { removePidFile(); process.exit(130); });
  process.on("SIGTERM", () => { removePidFile(); process.exit(143); });

  if (parentPid && Number.isInteger(parentPid)) {
    logger.info(`[lifecycle] heartbeat bound to parent pid ${parentPid}`);
    const timer = setInterval(() => {
      if (!isPidAlive(parentPid)) {
        logger.warn(`[lifecycle] parent ${parentPid} is gone — shutting down`);
        clearInterval(timer);
        removePidFile();
        process.exit(0);
      }
    }, HEARTBEAT_MS);
    timer.unref(); // don't block process exit
  }
}
