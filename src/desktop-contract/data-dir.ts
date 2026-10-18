// Where LAX keeps its per-user state, and the files in it that both the
// desktop app and the server read. One resolver on both sides: the desktop
// used to pin `~/.lax` while the server honoured LAX_DATA_DIR, so a relocated
// instance had its pidfile, config and rollback journal read from two places.

import { homedir } from "node:os";
import { join } from "node:path";
import { DESKTOP_ENV } from "./env.js";

/** The data directory: `LAX_DATA_DIR`, else `~/.lax`. Resolved per call so a
 *  late environment change (tests, a relaunch) is honoured. */
export function laxDataDir(): string {
  return process.env[DESKTOP_ENV.DATA_DIR] || join(homedir(), ".lax");
}

/** The app-owned Node runtime the installer provisions. An install location,
 *  not state: it stays under `~/.lax` whatever LAX_DATA_DIR says, because the
 *  installer (scripts/installer/) writes it there before any data dir exists. */
export function managedRuntimeDir(): string {
  return join(homedir(), ".lax", "runtime");
}

/** The server's pidfile (pidfile.ts): written by src/lifecycle.ts, read by the
 *  desktop to reclaim an orphaned server. */
export function serverPidPath(dataDir: string = laxDataDir()): string {
  return join(dataDir, "server.pid");
}

/** Port, auth token and projectRoot: written by the server, read by the
 *  desktop before it can reach the server. */
export function configPath(dataDir: string = laxDataDir()): string {
  return join(dataDir, "config.json");
}

export function logsDir(dataDir: string = laxDataDir()): string {
  return join(dataDir, "logs");
}

/** The update-rollback transaction (rollback-journal.ts). */
export const ROLLBACK_DIR = "update-rollback";
export const ROLLBACK_JOURNAL_FILE = "transaction.json";

export function rollbackDir(dataDir: string = laxDataDir()): string {
  return join(dataDir, ROLLBACK_DIR);
}

export function rollbackJournalPath(dataDir: string = laxDataDir()): string {
  return join(rollbackDir(dataDir), ROLLBACK_JOURNAL_FILE);
}

/** Where a superseded or unusable rollback transaction is moved aside, by the
 *  server after a completed install (by journal id) and by the desktop's
 *  pre-boot heal (by time). Neither deletes what it moves: the server prunes
 *  the folder only once a later update is known good (update-rollback-prune.ts),
 *  removing archives older than 30 days and always keeping the newest two. */
export const ROLLBACK_SUPERSEDED_DIR = "update-rollback-superseded";

export function supersededRollbackDir(dataDir: string, tag: string): string {
  return join(dataDir, ROLLBACK_SUPERSEDED_DIR, tag);
}

/** Written by the server's update pipeline when the desktop pre-build failed,
 *  read by the next desktop boot (prebuild-marker.ts). */
export function prebuildMarkerPath(dataDir: string = laxDataDir()): string {
  return join(dataDir, "desktop-prebuild-pending.json");
}
