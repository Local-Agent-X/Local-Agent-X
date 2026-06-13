import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { recallImportsByDate, listNearbyImportDates } from "../src/memory/import-recall.js";
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
// Storage shape (verified against the live store): imports are NOT source=
// 'import'. They're source='session' (same column as native LAX sessions) and
// carry metadata.source_type='import'/'claude-import'. The import signal is the
// source_type, which is also what keeps native foreign sessions out.

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
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
