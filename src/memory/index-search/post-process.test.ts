import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { postProcess } from "./post-process.js";
import { DEFAULT_MEMORY_CONFIG, type MemorySearchResult } from "../types.js";

const config = { ...DEFAULT_MEMORY_CONFIG, temporalDecayEnabled: false, mmrEnabled: false };

function hit(snippet: string, path: string, metadata: MemorySearchResult["metadata"], score = 1): MemorySearchResult {
  return { path, startLine: 1, endLine: 1, score, snippet, source: "session", metadata };
}

describe("since", () => {
  const rows = [
    // The older chat ranks higher, as the practice questions did over the debrief.
    hit("practice", "sessions/mobile-a.jsonl", { session_id: "a", datetime: "2026-11-09T19:36:00.000Z" }, 0.99),
    hit("debrief", "sessions/mobile-b.jsonl", { session_id: "b", datetime: "2026-11-10T21:00:00.000Z" }, 0.8),
    hit("old log", "2026-11-01.md", {}, 0.9),
    hit("undated page", "bank/entities/johnson.md", {}, 0.7),
  ];

  it("filters a chat transcript by the day it was said, not by its file name", () => {
    const db = new Database(":memory:");
    const kept = postProcess(db, config, rows, 10, -1, { crossSession: true, since: new Date("2026-11-10") }).map((r) => r.snippet);
    expect(kept).toContain("debrief");
    expect(kept).not.toContain("practice");
    expect(kept).not.toContain("old log");
    expect(kept).toContain("undated page");
    db.close();
  });

  it("filters before the top results are cut", () => {
    const db = new Database(":memory:");
    const kept = postProcess(db, config, rows, 1, -1, { crossSession: true, since: new Date("2026-11-10") }).map((r) => r.snippet);
    expect(kept).toEqual(["debrief"]);
    db.close();
  });
});
