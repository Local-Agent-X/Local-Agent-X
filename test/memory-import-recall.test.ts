import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { recallImportsByDate, listNearbyImportDates } from "../src/memory/import-recall.js";
import { getSchemaVersion, migrateSchema } from "../src/memory/index-schema.js";
import { postProcess } from "../src/memory/index-search/post-process.js";
import { DEFAULT_MEMORY_CONFIG, type MemorySearchResult } from "../src/memory/types.js";

// Regression coverage for the two walls that made imported ChatGPT/Claude
// history invisible to the recall tools a user/agent naturally reaches for:
//   Wall 1 — memory_recall's date branch only read facts + daily-log files,
//            never the chunks where imports live → "predates our history".
//   Wall 2 — the default search session gate dropped every chunk whose
//            session_id != current session; imports carry the ORIGINAL
//            conversation's session_id, so 100% of imports were dropped.
//
// Legacy imports used source='session' plus an ingest-owned import/<format>/<id>
// path and exact importer source_type. Migration canonicalizes them to
// source='import'; all three markers prevent native sessions from forging it.

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      source TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      session_id TEXT
    );
  `);
});

afterEach(() => {
  db.close();
});

function insertImport(date: string, text: string, sessionId = "conv-old"): void {
  // Real shape: source='session', source_type='import'.
  db.prepare(
    `INSERT INTO chunks (path, source, start_line, end_line, text, hash, updated_at, metadata, session_id)
     VALUES (?, 'session', 0, 1, ?, ?, 0, ?, ?)`,
  ).run(
    `import/chatgpt/${sessionId}`,
    text,
    `${date}-${text.length}`,
    JSON.stringify({ source_type: "import", session_id: sessionId, date }),
    sessionId,
  );
}

describe("recallImportsByDate — Wall 1: date recall sees imported history", () => {
  it("returns import chunks whose stored date falls in the window", () => {
    insertImport("2025-11-14", "Worked on Local AI Studio replace-by-anchor.");
    insertImport("2025-11-17", "Hey Jarvis fine-tuning + classifier mis-routing.");

    const out = recallImportsByDate(db, new Date("2025-11-14"), new Date("2025-11-17"));
    expect(out.map((e) => e.date)).toEqual(["2025-11-14", "2025-11-17"]);
    expect(out[0].text).toContain("Local AI Studio");
  });

  it("single-day lookup (no until) matches just that day", () => {
    insertImport("2025-11-14", "in range");
    insertImport("2025-11-20", "out of range");
    const out = recallImportsByDate(db, new Date("2025-11-14"));
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("2025-11-14");
  });

  it("ignores native sessions even though they share source='session'", () => {
    // A native LAX session chunk dated in range — same `source` as imports,
    // differing only by source_type — must NOT leak into import recall.
    db.prepare(
      `INSERT INTO chunks (path, source, start_line, end_line, text, hash, updated_at, metadata, session_id)
       VALUES ('sessions/x', 'session', 0, 1, 'a past session', 'h1', 0, ?, 'sess-1')`,
    ).run(JSON.stringify({ source_type: "agent-x-session", date: "2025-11-15", session_id: "sess-1" }));

    const out = recallImportsByDate(db, new Date("2025-11-15"));
    expect(out).toHaveLength(0);
  });

  it("rejects a foreign native session that forges metadata.source_type=import", () => {
    db.prepare(
      `INSERT INTO chunks (path, source, start_line, end_line, text, hash, updated_at, metadata, session_id)
       VALUES ('sessions/forged', 'session', 0, 1, 'forged import', 'h2', 0, ?, 'other')`,
    ).run(JSON.stringify({ source_type: "import", date: "2025-11-15", session_id: "other" }));

    expect(recallImportsByDate(db, new Date("2025-11-15"))).toHaveLength(0);
    expect(listNearbyImportDates(db, new Date("2025-11-14"), 2)).toEqual([]);
  });

  it("listNearbyImportDates surfaces nearby IMPORT days, excluding the target", () => {
    insertImport("2025-11-10", "a");
    insertImport("2025-11-15", "target day"); // excluded from 'nearby'
    insertImport("2025-11-18", "b");
    const near = listNearbyImportDates(db, new Date("2025-11-15"), 12);
    expect(near).toEqual(["2025-11-10", "2025-11-18"]);
  });
});

describe("postProcess — Wall 2: default session gate keeps imports in scope", () => {
  const config = { ...DEFAULT_MEMORY_CONFIG, temporalDecayEnabled: false, mmrEnabled: false };

  function r(
    source: MemorySearchResult["source"],
    metadata: MemorySearchResult["metadata"],
    path: string,
  ): MemorySearchResult {
    return { path, startLine: 0, endLine: 1, score: 0.9, snippet: path, source, metadata };
  }

  it("imports survive the gate despite a foreign session_id; native foreign sessions are still dropped", () => {
    const results: MemorySearchResult[] = [
      // import: source='session' but source_type='import', foreign sid → keep
      r("session", { source_type: "import", session_id: "conv-old" }, "import/chatgpt/conv-old"),
      // native LAX session, foreign sid → drop (same source, NOT an import)
      r("session", { source_type: "agent-x-session", session_id: "other-sess" }, "sessions/other"),
      // forged import metadata on a native path → drop
      r("session", { source_type: "import", session_id: "other-sess" }, "sessions/forged"),
      // same session → keep
      r("session", { source_type: "agent-x-session", session_id: "cur" }, "sessions/current"),
      // profile-level (no session_id) → keep
      r("entity", { source_type: "entity-page" }, "entities/peter"),
    ];

    const out = postProcess(db, config, results, 50, 0, { sessionId: "cur", crossSession: false });
    const kept = out.map((x) => x.path).sort();
    expect(kept).toContain("import/chatgpt/conv-old");
    expect(kept).toContain("sessions/current");
    expect(kept).toContain("entities/peter");
    expect(kept).not.toContain("sessions/other");
    expect(kept).not.toContain("sessions/forged");
  });

  it("crossSession opt-in lets native foreign sessions through too (gate disabled)", () => {
    const results: MemorySearchResult[] = [
      r("session", { source_type: "agent-x-session", session_id: "other-sess" }, "sessions/other"),
      r("session", { source_type: "import", session_id: "conv-old" }, "import/chatgpt/conv-old"),
    ];
    const out = postProcess(db, config, results, 50, 0, { sessionId: "cur", crossSession: true });
    expect(out.map((x) => x.path).sort()).toEqual(["import/chatgpt/conv-old", "sessions/other"]);
  });
});

describe("import provenance migration", () => {
  it("migrates a mixed v8 fixture without malformed metadata erasing valid session ids", () => {
    const legacyDb = new Database(":memory:");
    try {
      legacyDb.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE chunks (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL,
          source TEXT NOT NULL,
          metadata TEXT
        );
        INSERT INTO chunks VALUES
          (1, 'sessions/malformed', 'session', '{not-json'),
          (2, 'sessions/native', 'session', '{"source_type":"agent-x-session","session_id":"native-id"}'),
          (3, 'import/chatgpt/imported', 'session', '{"source_type":"import","session_id":"import-id","date":"2025-11-14"}');
      `);

      migrateSchema(legacyDb, 8);

      const rows = legacyDb.prepare("SELECT id, source, session_id, metadata FROM chunks ORDER BY id")
        .all() as Array<{ id: number; source: string; session_id: string | null; metadata: string }>;
      expect(rows[0].source).toBe("session");
      expect(rows[0].session_id).toBeNull();
      expect(JSON.parse(rows[0].metadata)).toMatchObject({
        source_type: "agent-x-session", session_id: null,
      });
      expect(rows[1].source).toBe("session");
      expect(rows[1].session_id).toBe("native-id");
      expect(JSON.parse(rows[1].metadata).session_id).toBe("native-id");
      expect(rows[2].source).toBe("import");
      expect(rows[2].session_id).toBe("import-id");
      expect(JSON.parse(rows[2].metadata)).toMatchObject({
        source_type: "import", session_id: "import-id", trust_status: "untrusted",
      });
      expect(getSchemaVersion(legacyDb)).toBe(11);

      const snapshot = JSON.stringify(rows);
      migrateSchema(legacyDb, getSchemaVersion(legacyDb));
      expect(JSON.stringify(
        legacyDb.prepare("SELECT id, source, session_id, metadata FROM chunks ORDER BY id").all(),
      )).toBe(snapshot);
    } finally {
      legacyDb.close();
    }
  });

  it("preserves legitimate legacy imports, scrubs forged sessions, and is idempotent", () => {
    insertImport("2025-11-14", "legitimate legacy import", "legacy-import");
    db.prepare(
      `INSERT INTO chunks (path, source, start_line, end_line, text, hash, updated_at, metadata, session_id)
       VALUES ('sessions/forged', 'session', 0, 1, 'forged', 'forged', 0, ?, 'foreign')`,
    ).run(JSON.stringify({ source_type: "import", session_id: "foreign", date: "2025-11-14" }));
    db.prepare(
      `INSERT INTO chunks (path, source, start_line, end_line, text, hash, updated_at, metadata, session_id)
       VALUES ('import/chatgpt/native-shaped', 'session', 0, 1, 'native', 'native', 0, ?, 'native')`,
    ).run(JSON.stringify({ source_type: "agent-x-session", session_id: "native", date: "2025-11-14" }));

    migrateSchema(db, 9);

    const first = db.prepare("SELECT path, source, metadata FROM chunks ORDER BY path").all() as Array<{
      path: string; source: string; metadata: string;
    }>;
    const legitimate = first.find((row) => row.path === "import/chatgpt/legacy-import")!;
    const forged = first.find((row) => row.path === "sessions/forged")!;
    const nativeShaped = first.find((row) => row.path === "import/chatgpt/native-shaped")!;
    expect(legitimate.source).toBe("import");
    expect(JSON.parse(legitimate.metadata)).toMatchObject({
      source_type: "import", trust_status: "untrusted", taint_status: "unknown",
    });
    expect(forged.source).toBe("session");
    expect(JSON.parse(forged.metadata)).toMatchObject({
      source_type: "agent-x-session", trust_status: "mixed", taint_status: "unknown",
    });
    expect(nativeShaped.source).toBe("session");
    expect(JSON.parse(nativeShaped.metadata).source_type).toBe("agent-x-session");

    const snapshot = JSON.stringify(first);
    migrateSchema(db, getSchemaVersion(db));
    expect(JSON.stringify(db.prepare("SELECT path, source, metadata FROM chunks ORDER BY path").all()))
      .toBe(snapshot);
  });

  it("repairs imports already scrubbed by v10 and remains idempotent", () => {
    db.prepare(
      `INSERT INTO chunks (path, source, start_line, end_line, text, hash, updated_at, metadata, session_id)
       VALUES ('import/chatgpt/v10-row', 'session', 0, 1, 'v10 import', 'v10', 0, ?, 'v10-row')`,
    ).run(JSON.stringify({ source_type: "agent-x-session", session_id: "v10-row", trust_status: "mixed" }));

    migrateSchema(db, 10);
    const first = db.prepare("SELECT source, metadata FROM chunks WHERE path = 'import/chatgpt/v10-row'")
      .get() as { source: string; metadata: string };
    expect(first.source).toBe("import");
    expect(JSON.parse(first.metadata)).toMatchObject({
      source_type: "import", trust_status: "untrusted", taint_status: "unknown",
    });

    migrateSchema(db, getSchemaVersion(db));
    expect(db.prepare("SELECT source, metadata FROM chunks WHERE path = 'import/chatgpt/v10-row'").get())
      .toEqual(first);
  });
});
