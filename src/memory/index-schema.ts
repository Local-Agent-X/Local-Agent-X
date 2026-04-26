import type Database from "better-sqlite3";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-schema");

export const CURRENT_SCHEMA_VERSION = 8;

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

export function migrateSchema(
  db: InstanceType<typeof Database>,
  fromVersion: number
): void {
  logger.info(
    `[memory] Migrating schema from v${fromVersion} to v${CURRENT_SCHEMA_VERSION}`
  );

  db.transaction(() => {
    if (fromVersion < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL,
          source TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          text TEXT NOT NULL,
          hash TEXT NOT NULL,
          embedding TEXT,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
        CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

        CREATE TABLE IF NOT EXISTS embedding_cache (
          hash TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'default',
          model TEXT NOT NULL DEFAULT 'default',
          embedding TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (hash, provider, model)
        );

        CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at
          ON embedding_cache(updated_at);
      `);
    }

    if (fromVersion < 2) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK(kind IN ('world','experience','opinion','observation')),
          content TEXT NOT NULL,
          entities TEXT NOT NULL DEFAULT '[]',
          confidence REAL NOT NULL DEFAULT 1.0,
          evidence_for TEXT NOT NULL DEFAULT '[]',
          evidence_against TEXT NOT NULL DEFAULT '[]',
          source_file TEXT NOT NULL,
          source_line INTEGER NOT NULL DEFAULT 0,
          timestamp INTEGER NOT NULL,
          last_updated INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(kind);
        CREATE INDEX IF NOT EXISTS idx_facts_timestamp ON facts(timestamp);

        CREATE TABLE IF NOT EXISTS entity_mentions (
          fact_id INTEGER NOT NULL,
          entity_slug TEXT NOT NULL,
          PRIMARY KEY (fact_id, entity_slug),
          FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_entity_mentions_slug ON entity_mentions(entity_slug);
      `);
    }

    if (fromVersion < 3) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_dedup
          ON facts(kind, content, entities);
      `);
    }

    if (fromVersion < 4) {
      try { db.exec(`ALTER TABLE chunks ADD COLUMN metadata TEXT DEFAULT NULL`); } catch { /* column may already exist */ }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_metadata ON chunks(metadata)`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_ingest_log (
          conversation_id TEXT PRIMARY KEY,
          title TEXT,
          create_time REAL,
          message_count INTEGER,
          source_format TEXT,
          ingested_at INTEGER NOT NULL
        )
      `);
    }

    if (fromVersion < 5) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entity_relations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subject TEXT NOT NULL,
          predicate TEXT NOT NULL,
          object TEXT NOT NULL,
          fact_id INTEGER,
          chunk_id INTEGER,
          confidence REAL NOT NULL DEFAULT 1.0,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE,
          FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_relations_subject ON entity_relations(subject);
        CREATE INDEX IF NOT EXISTS idx_relations_object ON entity_relations(object);
        CREATE INDEX IF NOT EXISTS idx_relations_predicate ON entity_relations(predicate);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique
          ON entity_relations(subject, predicate, object, COALESCE(fact_id, -1), COALESCE(chunk_id, -1));
      `);
    }

    if (fromVersion < 6) {
      try { db.exec(`ALTER TABLE facts ADD COLUMN valid_from INTEGER`); } catch {}
      try { db.exec(`ALTER TABLE facts ADD COLUMN valid_to INTEGER`); } catch {}
      try { db.exec(`ALTER TABLE facts ADD COLUMN invalidated_by INTEGER`); } catch {}
      try { db.exec(`ALTER TABLE facts ADD COLUMN invalidation_reason TEXT`); } catch {}
      db.exec(`UPDATE facts SET valid_from = timestamp WHERE valid_from IS NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_valid_to ON facts(valid_to)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_valid_from ON facts(valid_from)`);
    }

    if (fromVersion < 7) {
      db.exec(`DROP INDEX IF EXISTS idx_facts_dedup`);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_dedup_valid
          ON facts(kind, content, entities) WHERE valid_to IS NULL
      `);
    }

    if (fromVersion < 8) {
      try { db.exec(`ALTER TABLE chunks ADD COLUMN content_hash TEXT`); } catch {}
      db.exec(`UPDATE chunks SET content_hash = hash WHERE content_hash IS NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path_hash ON chunks(path, content_hash)`);

      db.exec(`UPDATE chunks SET source = 'entity'  WHERE source = 'entities'`);
      db.exec(`UPDATE chunks SET source = 'session' WHERE source = 'sessions'`);
      db.exec(`UPDATE chunks SET source = 'mind'
                      WHERE source = 'memory' AND path LIKE '%MIND.md'`);
      db.exec(`UPDATE chunks SET source = 'session-summary'
                      WHERE source = 'memory' AND path LIKE '%session-summaries%'`);
      db.exec(`UPDATE chunks SET source = 'daily-log'
                      WHERE source = 'memory'
                        AND path GLOB '*[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md'`);
      db.exec(`UPDATE chunks SET source = 'personality' WHERE source = 'memory'`);

      db.exec(`UPDATE files SET source = 'entity'  WHERE source = 'entities'`);
      db.exec(`UPDATE files SET source = 'session' WHERE source = 'sessions'`);
      db.exec(`UPDATE files SET source = 'mind'
                      WHERE source = 'memory' AND path LIKE '%MIND.md'`);
      db.exec(`UPDATE files SET source = 'session-summary'
                      WHERE source = 'memory' AND path LIKE '%session-summaries%'`);
      db.exec(`UPDATE files SET source = 'daily-log'
                      WHERE source = 'memory'
                        AND path GLOB '*[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md'`);
      db.exec(`UPDATE files SET source = 'personality' WHERE source = 'memory'`);
    }

    db
      .prepare(
        `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`
      )
      .run(String(CURRENT_SCHEMA_VERSION));
  })();
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
        content_rowid=id
      );
    `);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        content,
        content=facts,
        content_rowid=id
      );
    `);
    hasFts = true;
  } catch {
    logger.info("[memory] FTS5 not available — keyword search disabled");
  }

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
