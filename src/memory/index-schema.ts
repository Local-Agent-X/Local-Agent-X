import type Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, migrateSchema } from "./index-schema-migrations.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-schema");

// Migration steps live in index-schema-migrations.ts (LOC cap); re-export so
// existing consumers of this module keep one import site.
export { CURRENT_SCHEMA_VERSION, migrateSchema };

/** Both keyword indexes stem, so every-word search matches across word
 *  endings ("text" ~ "texted"). Changing it needs a migration that drops and
 *  rebuilds the tables (v16). */
export const FTS_TOKENIZE = "'porter unicode61'";

export function getSchemaVersion(db: InstanceType<typeof Database>): number {
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

export function initSchema(
  db: InstanceType<typeof Database>
): { hasFts: boolean } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const existingVersion = getSchemaVersion(db);

  if (existingVersion < CURRENT_SCHEMA_VERSION) {
    migrateSchema(db, existingVersion);
  }

  let hasFts = false;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        content=chunks,
        content_rowid=id,
        tokenize=${FTS_TOKENIZE}
      );
    `);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        content,
        content=facts,
        content_rowid=id,
        tokenize=${FTS_TOKENIZE}
      );
    `);
    hasFts = true;
  } catch {
    logger.info("[memory] FTS5 not available — keyword search disabled");
  }
  // v16 dropped both tables to change their tokenizer; refill from the source rows.
  if (hasFts && existingVersion > 0 && existingVersion < 16) rebuildFtsIndex(db, hasFts);

  logger.info(`[memory] Schema migration complete (v${CURRENT_SCHEMA_VERSION})`);
  return { hasFts };
}

export function rebuildFtsIndex(
  db: InstanceType<typeof Database>,
  hasFts: boolean
): void {
  if (!hasFts) return;
  logger.info("[memory] Rebuilding FTS index...");

  db.transaction(() => {
    try {
      db.exec("DELETE FROM chunks_fts");
    } catch {}
    const chunks = db
      .prepare("SELECT id, text FROM chunks")
      .all() as Array<{ id: number; text: string }>;
    const insertChunkFts = db.prepare(
      "INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)"
    );
    for (const chunk of chunks) {
      try {
        insertChunkFts.run(chunk.id, chunk.text);
      } catch {}
    }

    try {
      db.exec("DELETE FROM facts_fts");
    } catch {}
    const facts = db
      .prepare("SELECT id, content FROM facts")
      .all() as Array<{ id: number; content: string }>;
    const insertFactFts = db.prepare(
      "INSERT INTO facts_fts (rowid, content) VALUES (?, ?)"
    );
    for (const fact of facts) {
      try {
        insertFactFts.run(fact.id, fact.content);
      } catch {}
    }
  })();

  logger.info("[memory] FTS rebuild complete");
}
