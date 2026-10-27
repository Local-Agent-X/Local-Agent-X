// A project document reaches only a search made for its own project: in the
// SQL of both channels and again in post-processing, whatever the session
// scope. A shared path prefix (proj-a / proj-ab) must not leak either.
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { searchKeyword } from "./keyword-search.js";
import { searchVector } from "./vector-search.js";
import { postProcess } from "./post-process.js";
import { describeChunkProvenance } from "../search-helpers.js";
import { DEFAULT_MEMORY_CONFIG, type MemorySearchResult } from "../types.js";

function searchDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL,
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, text TEXT NOT NULL,
      embedding TEXT, metadata TEXT, session_id TEXT, updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content=chunks, content_rowid=id);
  `);
  const insert = db.prepare(
    "INSERT INTO chunks (id, path, source, start_line, end_line, text, embedding, metadata, session_id, updated_at) VALUES (?, ?, ?, 1, 1, ?, '[1,0]', ?, ?, 1)",
  );
  const rows = [
    [1, "bank/entities/acme.md", "entity", "needle entity", null, null],
    [2, "session-current", "session", "needle session", null, "current"],
    [3, "project/proj-a/pricing.md", "project-doc", "needle pricing", null, null],
    [4, "project/proj-ab/notes.md", "project-doc", "needle notes", null, null],
    // Metadata naming a project is not scope: only source and path are.
    [5, "project/proj-b/plan.md", "project-doc", "needle plan", JSON.stringify({ project: "proj-a", project_id: "proj-a" }), "current"],
  ] as const;
  for (const r of rows) {
    insert.run(...r);
    db.prepare("INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)").run(r[0], r[3]);
  }
  return db;
}

const ids = (rows: Array<{ id?: number }>) => rows.map((r) => r.id).sort();

describe("project documents in the search SQL", () => {
  it("are invisible to a search with no project, session-scoped or cross-session", () => {
    const db = searchDb();
    for (const sessionFilter of ["current", null, undefined] as const) {
      expect(ids(searchKeyword(db, "needle", 20, undefined, sessionFilter)).some((id) => id! >= 3)).toBe(false);
      expect(ids(searchVector(db, [1, 0], 20, undefined, sessionFilter)).some((id) => id! >= 3)).toBe(false);
    }
    db.close();
  });

  it("reach a search for their own project only, never a project sharing a prefix or named in metadata", () => {
    const db = searchDb();
    expect(ids(searchKeyword(db, "needle", 20, undefined, "current", "all", "proj-a"))).toEqual([1, 2, 3]);
    expect(ids(searchVector(db, [1, 0], 20, undefined, "current", "proj-a"))).toEqual([1, 2, 3]);
    expect(ids(searchKeyword(db, "needle", 20, undefined, undefined, "all", "proj-a"))).toEqual([1, 2, 3]);
    expect(ids(searchVector(db, [1, 0], 20, undefined, null, "proj-ab"))).toEqual([1, 4]);
    db.close();
  });
});

describe("project documents in post-processing", () => {
  const mk = (n: number, source: MemorySearchResult["source"], path: string): MemorySearchResult =>
    ({ path, startLine: 1, endLine: 1, score: 1, snippet: String(n), source, metadata: { session_id: "current" } });
  const rows = [
    mk(1, "entity", "bank/entities/acme.md"),
    mk(3, "project-doc", "project/proj-a/pricing.md"),
    mk(4, "project-doc", "project/proj-ab/notes.md"),
  ];
  const config = { ...DEFAULT_MEMORY_CONFIG, temporalDecayEnabled: false, mmrEnabled: false };

  it("keep only the searched project's documents, in session and cross-session mode", () => {
    const db = new Database(":memory:");
    const snippets = (o: Parameters<typeof postProcess>[5]) => postProcess(db, config, rows, 10, -1, o).map((r) => r.snippet).sort();
    expect(snippets({ sessionId: "current" })).toEqual(["1"]);
    expect(snippets({ sessionId: "current", crossSession: true })).toEqual(["1"]);
    expect(snippets({ sessionId: "current", projectId: "proj-a" })).toEqual(["1", "3"]);
    expect(snippets({ crossSession: true, projectId: "proj-ab" })).toEqual(["1", "4"]);
    db.close();
  });
});

describe("project document provenance", () => {
  it("is untrusted whatever the chunk's metadata claims", () => {
    const p = describeChunkProvenance("project-doc", { trust_status: "trusted", taint_status: "clean" });
    expect(p.trust_status).toBe("untrusted");
    expect(p.source_type).toBe("project-file");
    expect(p.label).toBe("Project document");
  });
});
