/**
 * Schema v12 — per-fact provenance column.
 *
 * The promotion capability's origin (MemoryContentOrigin) was computed at
 * write time and then dropped at the DB boundary. v12 adds
 * `facts.provenance TEXT` via the guarded-ALTER pattern. Fresh installs run
 * migrateSchema(db, 0) (initSchema), so the ALTER covers them too — the v2
 * CREATE TABLE deliberately stays v2-shaped.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, migrateSchema } from "./index-schema-migrations.js";
import { initSchema } from "./index-schema.js";

type Db = InstanceType<typeof Database>;

function factColumns(db: Db): string[] {
  return (db.prepare("PRAGMA table_info('facts')").all() as Array<{ name: string }>)
    .map((c) => c.name);
}

function schemaVersion(db: Db): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
  return parseInt(row.value, 10);
}

// A v11-era DB: meta + the facts table exactly as v2 CREATE + v6 ALTERs left
// it (no provenance column), with pre-existing rows.
function buildV11Db(): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema_version', '11');
    CREATE TABLE facts (
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
      last_updated INTEGER NOT NULL,
      valid_from INTEGER,
      valid_to INTEGER,
      invalidated_by INTEGER,
      invalidation_reason TEXT
    );
    CREATE TABLE entity_mentions (
      fact_id INTEGER NOT NULL,
      entity_slug TEXT NOT NULL,
      PRIMARY KEY (fact_id, entity_slug)
    );
    INSERT INTO facts (kind, content, source_file, timestamp, last_updated, valid_from)
    VALUES ('world', 'pre-migration fact one', 'daily.md', 1000, 1000, 1000),
           ('opinion', 'pre-migration fact two', 'daily.md', 2000, 2000, 2000);
    INSERT INTO entity_mentions (fact_id, entity_slug) VALUES (1, 'p');
  `);
  return db;
}

describe("schema v12 fact provenance migration", () => {
  it("adds the provenance column, leaves old rows NULL, and stamps v12", () => {
    const db = buildV11Db();
    try {
      expect(factColumns(db)).not.toContain("provenance");

      migrateSchema(db, 11);

      expect(factColumns(db)).toContain("provenance");
      const rows = db.prepare("SELECT provenance FROM facts ORDER BY id").all() as Array<{ provenance: string | null }>;
      expect(rows).toEqual([{ provenance: null }, { provenance: null }]);
      expect(schemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(CURRENT_SCHEMA_VERSION).toBe(16);
    } finally {
      db.close();
    }
  });

  it("is idempotent on re-run (duplicate-column ALTER is absorbed)", () => {
    const db = buildV11Db();
    try {
      migrateSchema(db, 11);
      expect(() => migrateSchema(db, 11)).not.toThrow();

      expect(factColumns(db).filter((c) => c === "provenance")).toHaveLength(1);
      const rows = db.prepare("SELECT content, provenance FROM facts ORDER BY id").all() as Array<{ content: string; provenance: string | null }>;
      expect(rows).toEqual([
        { content: "pre-migration fact one", provenance: null },
        { content: "pre-migration fact two", provenance: null },
      ]);
      expect(schemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("gives fresh installs the provenance column via the from-0 migration path", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      expect(factColumns(db)).toContain("provenance");
      expect(schemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

      db.prepare(
        `INSERT INTO facts (kind, content, source_file, timestamp, last_updated, provenance)
         VALUES ('world', 'fresh-install fact', 'x.md', 1, 1, 'user_statement')`
      ).run();
      const row = db.prepare("SELECT provenance FROM facts").get() as { provenance: string };
      expect(row.provenance).toBe("user_statement");
    } finally {
      db.close();
    }
  });
});

describe("schema v13 entity-link backfill", () => {
  it("purges junk mentions and links untagged legacy facts by content", () => {
    const db = buildV11Db();
    try {
      db.prepare(
        `INSERT INTO facts (kind, content, source_file, timestamp, last_updated, valid_from)
         VALUES ('observation', 'User selected Merchhelm after StockPilot was taken.', 'daily.md', 3000, 3000, 3000)`
      ).run();

      migrateSchema(db, 11);

      // Junk slug 'p' from the fixture is gone.
      const junk = db.prepare("SELECT COUNT(*) n FROM entity_mentions WHERE entity_slug = 'p'").get() as { n: number };
      expect(junk.n).toBe(0);
      // The untagged fact is now reachable by entity.
      const slugs = (db
        .prepare("SELECT entity_slug FROM entity_mentions WHERE fact_id = 3")
        .all() as Array<{ entity_slug: string }>)
        .map((r) => r.entity_slug);
      expect(slugs).toContain("merchhelm");
      expect(slugs).toContain("stockpilot");
    } finally {
      db.close();
    }
  });
});

/**
 * Schema v14 — event time, separate from write time.
 *
 * `facts.timestamp` is Date.now() at index time. Consolidation runs whenever it
 * runs, so that is not when the thing happened, and the entity page rendered it
 * as though it were (live case 2026-09-22: a conversation from the 22nd read as
 * "today, 2026-09-23" because the pass that recorded it ran on the 23rd).
 */
describe("schema v14 fact event-time migration", () => {
  it("adds occurred_at and leaves pre-existing rows NULL rather than backfilling the write time", () => {
    const db = buildV11Db();
    try {
      migrateSchema(db, 13);

      expect(factColumns(db)).toContain("occurred_at");

      // THE load-bearing assertion. Backfilling occurred_at from timestamp
      // would launder the wrong answer into a column that claims to be
      // authoritative — every one of those rows would then assert an event
      // date that is really a write date. NULL is the truth: we do not know
      // when these happened.
      const rows = db.prepare("SELECT occurred_at, timestamp FROM facts ORDER BY id")
        .all() as Array<{ occurred_at: number | null; timestamp: number }>;
      expect(rows.every(r => r.occurred_at === null)).toBe(true);
      expect(rows.every(r => typeof r.timestamp === "number")).toBe(true);

      expect(schemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("survives a database that has no facts table at all", () => {
    // search-helpers.test.ts migrates a chunks-only DB. An unguarded CREATE
    // INDEX on facts threw there and took the whole migration transaction with
    // it, which would brick any install whose schema is shaped that way.
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta (key, value) VALUES ('schema_version', '13');
      `);
      expect(() => migrateSchema(db, 13)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("schema v16 stemmed keyword indexes", () => {
  const match = (db: Db, table: "chunks_fts" | "facts_fts", term: string) =>
    (db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).all(`"${term}"`) as Array<{ rowid: number }>).map((r) => r.rowid);

  // A v15 database: the full schema, but FTS tables created unstemmed and
  // holding the rows the old tokenizer indexed.
  function buildV15Db(): Db {
    const db = new Database(":memory:");
    initSchema(db);
    db.exec(`
      DROP TABLE chunks_fts; DROP TABLE facts_fts;
      CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content=chunks, content_rowid=id);
      CREATE VIRTUAL TABLE facts_fts USING fts5(content, content=facts, content_rowid=id);
      UPDATE meta SET value = '15' WHERE key = 'schema_version';
    `);
    db.prepare("INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, updated_at) VALUES (1, 's.jsonl', 'session', 1, 2, ?, 'h', 0)")
      .run('[user] in 2014 my cousin texted my brother "did you sell Merriweather yet"');
    db.prepare("INSERT INTO chunks_fts (rowid, text) VALUES (1, ?)").run('[user] in 2014 my cousin texted my brother "did you sell Merriweather yet"');
    db.prepare("INSERT INTO facts (id, kind, content, source_file, timestamp, last_updated) VALUES (1, 'experience', 'Odalys moved her boats to slip 31', 'x', 0, 0)").run();
    db.prepare("INSERT INTO facts_fts (rowid, content) VALUES (1, 'Odalys moved her boats to slip 31')").run();
    return db;
  }

  it("a v15 index misses word endings — the every-word search that lost the source (2026-10-08)", () => {
    const db = buildV15Db();
    expect(match(db, "chunks_fts", "text")).toEqual([]);
    expect(match(db, "facts_fts", "boat")).toEqual([]);
  });

  it("upgrading rebuilds both indexes stemmed, keeping every row", () => {
    const db = buildV15Db();
    initSchema(db);
    expect(schemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(match(db, "chunks_fts", "text")).toEqual([1]);
    expect(match(db, "chunks_fts", "Merriweather")).toEqual([1]);
    expect(match(db, "facts_fts", "boat")).toEqual([1]);
    expect(match(db, "facts_fts", "move")).toEqual([1]);
  });

  it("a fresh database stems from the start, and reopening does not rebuild", () => {
    const db = new Database(":memory:");
    initSchema(db);
    db.prepare("INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, updated_at) VALUES (7, 'p', 'session', 1, 1, 'she texted him', 'h', 0)").run();
    db.prepare("INSERT INTO chunks_fts (rowid, text) VALUES (7, 'she texted him')").run();
    expect(match(db, "chunks_fts", "texts")).toEqual([7]);
    initSchema(db);
    expect(match(db, "chunks_fts", "text")).toEqual([7]);
  });
});
