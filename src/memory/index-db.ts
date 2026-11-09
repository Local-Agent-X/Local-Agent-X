import { existsSync, copyFileSync, unlinkSync, chmodSync } from "node:fs";
import Database from "better-sqlite3";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-db");

let _sqliteVecLoad: ((db: any) => void) | null = null;
try {
  const mod = await import("sqlite-vec");
  _sqliteVecLoad = mod.load;
} catch {}

/** `onRecreated` hears that the file could not be opened and an empty one
 *  took its place (the old one copied to `movedTo`), so the caller can
 *  restore what it can (db-backup.ts restoreFacts) and tell the user. */
export function openDatabaseSafe(dbPath: string, onRecreated?: (movedTo: string) => void): InstanceType<typeof Database> {
  let db: InstanceType<typeof Database>;
  let opened: InstanceType<typeof Database> | null = null;
  try {
    db = opened = new Database(dbPath);
    // Opening reads nothing: a file that is not a database ("file is not a
    // database") opens fine and fails on the first query, which crashed the
    // server at start instead of reaching the recovery below.
    db.prepare("SELECT COUNT(*) FROM sqlite_master").get();
    try { chmodSync(dbPath, 0o600); } catch {}
  } catch (e) {
    logger.warn(`[memory] Cannot open database: ${(e as Error).message}`);
    // Windows will not delete a file this process still holds open.
    try { opened?.close(); } catch {}
    const backup = dbPath + ".backup-" + Date.now();
    try {
      if (existsSync(dbPath)) copyFileSync(dbPath, backup);
      unlinkSync(dbPath);
    } catch {}
    db = new Database(dbPath);
    logger.info(`[memory] Recreated database (old backed up to ${backup})`);
    onRecreated?.(backup);
  }

  // Boot-time db.pragma("quick_check") was the biggest single cost in
  // the server boot path on machines with real data — 30s on a 1.5GB
  // memory.db, near-zero on a fresh install. It scanned the whole file
  // looking for soft corruption every restart, even though the open()
  // above + better-sqlite3's strict reads already surface hard
  // corruption (caught by the outer try/catch which copies the file
  // aside and recreates). The tables nothing can rebuild are read in full
  // and checked by the daily snapshot (db-backup.ts), which tells the user
  // when it fails. Force a one-off check of the whole file with
  // LAX_DB_INTEGRITY_CHECK=true for debugging.
  if (process.env.LAX_DB_INTEGRITY_CHECK === "true") {
    try {
      const result = db.pragma("quick_check") as Array<{ quick_check: string }>;
      if (result[0]?.quick_check !== "ok") {
        logger.warn("[memory] Database integrity check failed, backing up and recreating");
        const backup = dbPath + ".backup-" + Date.now();
        db.close();
        copyFileSync(dbPath, backup);
        unlinkSync(dbPath);
        db = new Database(dbPath);
        onRecreated?.(backup);
      }
    } catch {
    }
  }

  if (_sqliteVecLoad) {
    try {
      _sqliteVecLoad(db);
      logger.info("[memory] sqlite-vec loaded");
    } catch (e) {
      logger.info("[memory] sqlite-vec load failed:", (e as Error).message?.slice(0, 100));
    }
  }

  return db;
}
