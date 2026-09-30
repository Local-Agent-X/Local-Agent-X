import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../memory/index.js";
import { importFactsFromSync } from "./facts-sync.js";

let root = "";
let memory: MemoryIndex;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-facts-sync-"));
  mkdirSync(join(root, "data", "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(root, "data", "memory", "session-summaries"), { recursive: true });
  mkdirSync(join(root, "sync"), { recursive: true });
  memory = new MemoryIndex(join(root, "data"), { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch { /* already closed */ }
  rmSync(root, { recursive: true, force: true });
});

const remoteFact = {
  kind: "observation",
  content: "Josiah at LangChain asked for the resume by email",
  entities: JSON.stringify(["Josiah"]),
  confidence: 0.8,
  evidence_for: "[]",
  evidence_against: "[]",
  source_file: "sessions/other-machine.jsonl",
  source_line: 12,
  timestamp: 1_700_000_000_000,
  last_updated: 1_700_000_000_000,
  valid_from: null,
  valid_to: null,
  invalidation_reason: null,
  invalidated_by_key: null,
};

describe("a fact synced from another machine", () => {
  it("is searchable here right after import, not only after a full rebuild", () => {
    writeFileSync(join(root, "sync", "facts.jsonl"), `${JSON.stringify(remoteFact)}\n`);
    memory.close();
    expect(importFactsFromSync(join(root, "data"), join(root, "sync"))).toMatchObject({ inserted: 1 });
    memory = new MemoryIndex(join(root, "data"), { minScore: -1 });
    const db = memory["db"] as import("better-sqlite3").Database;
    const hits = db.prepare("SELECT f.content FROM facts_fts fts JOIN facts f ON f.id = fts.rowid WHERE facts_fts MATCH ?")
      .all("resume") as Array<{ content: string }>;
    expect(hits.map((h) => h.content)).toEqual([remoteFact.content]);
  });
});
