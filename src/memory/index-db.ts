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
