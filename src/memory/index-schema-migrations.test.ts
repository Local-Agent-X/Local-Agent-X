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
    INSERT INTO facts (kind, content, source_file, timestamp, last_updated, valid_from)
    VALUES ('world', 'pre-migration fact one', 'daily.md', 1000, 1000, 1000),
           ('opinion', 'pre-migration fact two', 'daily.md', 2000, 2000, 2000);
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
      expect(CURRENT_SCHEMA_VERSION).toBe(12);
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
