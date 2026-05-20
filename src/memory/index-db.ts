import { existsSync, copyFileSync, unlinkSync, chmodSync } from "node:fs";
import Database from "better-sqlite3";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-db");

let _sqliteVecLoad: ((db: any) => void) | null = null;
try {
  const mod = await import("sqlite-vec");
  _sqliteVecLoad = mod.load;
} catch {}

export function openDatabaseSafe(dbPath: string): InstanceType<typeof Database> {
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath);
    try { chmodSync(dbPath, 0o600); } catch {}
  } catch (e) {
    logger.warn(`[memory] Cannot open database: ${(e as Error).message}`);
    const backup = dbPath + ".backup-" + Date.now();
    try {
      if (existsSync(dbPath)) copyFileSync(dbPath, backup);
      unlinkSync(dbPath);
    } catch {}
    db = new Database(dbPath);
    logger.info(`[memory] Recreated database (old backed up to ${backup})`);
  }

  // Boot-time db.pragma("quick_check") was the biggest single cost in
  // the server boot path on machines with real data — 30s on a 1.5GB
  // memory.db, near-zero on a fresh install. It scanned the whole file
  // looking for soft corruption every restart, even though the open()
  // above + better-sqlite3's strict reads already surface hard
  // corruption (caught by the outer try/catch which copies the file
  // aside and recreates). Moved to a background job (every 7 days from
  // server.scheduler) so the integrity guarantee stays without blocking
  // boot. Force a one-off check with LAX_DB_INTEGRITY_CHECK=true for
  // debugging.
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
