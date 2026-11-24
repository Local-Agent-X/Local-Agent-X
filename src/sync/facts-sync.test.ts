import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../memory/index.js";
import { importFactsFromSync } from "./facts-sync.js";
import { authorizeTestFactMutations } from "../memory/test-promotion.test-helper.js";

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

  it("keeps where it came from, and is logged as sync's change", () => {
    const withOrigin = { ...remoteFact, provenance: "assistant", occurred_at: 1_699_000_000_000, source_message_id: "msg-7" };
    writeFileSync(join(root, "sync", "facts.jsonl"), `${JSON.stringify(withOrigin)}\n`);
    memory.close();
    importFactsFromSync(join(root, "data"), join(root, "sync"));
    memory = new MemoryIndex(join(root, "data"), { minScore: -1 });
    const db = memory["db"] as import("better-sqlite3").Database;
    expect(db.prepare("SELECT provenance, occurred_at, source_message_id FROM facts").get())
      .toEqual({ provenance: "assistant", occurred_at: 1_699_000_000_000, source_message_id: "msg-7" });
    expect(memory.memoryChanges({ ops: ["create"] })[0].actor).toBe("sync");
  });

  it("arrives with each source of its evidence once, from a machine that still repeats them", () => {
    const repeated = { ...remoteFact, evidence_for: JSON.stringify(["a.md#L1", "a.md#L1", "b.md#L2", "a.md#L1"]) };
    writeFileSync(join(root, "sync", "facts.jsonl"), `${JSON.stringify(repeated)}\n`);
    memory.close();
    importFactsFromSync(join(root, "data"), join(root, "sync"));
    memory = new MemoryIndex(join(root, "data"), { minScore: -1 });
    const db = memory["db"] as import("better-sqlite3").Database;
    expect(JSON.parse((db.prepare("SELECT evidence_for FROM facts").get() as { evidence_for: string }).evidence_for))
      .toEqual(["a.md#L1", "b.md#L2"]);
  });

  it("is linked into the relation graph here, as a fact learned here is", () => {
    const linked = { ...remoteFact, content: "Josiah runs hiring for [[LangChain]]" };
    writeFileSync(join(root, "sync", "facts.jsonl"), `${JSON.stringify(linked)}
`);
    memory.close();
    importFactsFromSync(join(root, "data"), join(root, "sync"));
    memory = new MemoryIndex(join(root, "data"), { minScore: -1 });
    expect(memory.getRelationsFor("Josiah"))
      .toContainEqual(expect.objectContaining({ subject: "josiah", predicate: "links-to", object: "langchain" }));
    expect(memory.traverseFrom("LangChain", 1).has("josiah")).toBe(true);
  });

  it("does not come back here once the user erased it here", () => {
    authorizeTestFactMutations(memory);
    memory.rememberFact(remoteFact.content, { kind: "observation", sourceFile: "agent-tool:user-statement" });
    const db = memory["db"] as import("better-sqlite3").Database;
    const row = db.prepare("SELECT kind, content, entities FROM facts").get() as { kind: string; content: string; entities: string };
    expect(memory.forgetFacts("resume")).toBe(1);
    writeFileSync(join(root, "sync", "facts.jsonl"), `${JSON.stringify({ ...remoteFact, ...row })}\n`);
    memory.close();

    expect(importFactsFromSync(join(root, "data"), join(root, "sync"))).toMatchObject({ inserted: 0, skipped: 1 });
  });
});

// The import reads this machine's facts once and matches each synced fact
// against them, where it used to query the table per fact. What it does with
// each fact must not change.
describe("importing facts this machine already holds", () => {
  const rowsOf = (): Array<{ content: string; valid_to: number | null; last_updated: number }> => {
    const db = memory["db"] as import("better-sqlite3").Database;
    return db.prepare("SELECT content, valid_to, last_updated FROM facts ORDER BY id").all() as Array<{ content: string; valid_to: number | null; last_updated: number }>;
  };
  const importOnce = (lines: object[]): { inserted: number; updated: number; skipped: number } => {
    writeFileSync(join(root, "sync", "facts.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    memory.close();
    const result = importFactsFromSync(join(root, "data"), join(root, "sync"));
    memory = new MemoryIndex(join(root, "data"), { minScore: -1 });
    return result;
  };

  it("skips them on a second import, adding no row", () => {
    const other = { ...remoteFact, content: "The office closes at six on Fridays", entities: "[]" };
    expect(importOnce([remoteFact, other])).toMatchObject({ inserted: 2 });
    expect(importOnce([remoteFact, other])).toEqual({ inserted: 0, updated: 0, skipped: 2 });
    expect(rowsOf()).toHaveLength(2);
  });

  it("merges a fact listed twice in one file into the row the first line made", () => {
    const ended = { ...remoteFact, valid_to: 1_700_000_500_000, invalidation_reason: "superseded", last_updated: 1_700_000_500_000 };
    const result = importOnce([remoteFact, ended]);
    expect(result).toEqual({ inserted: 1, updated: 1, skipped: 0 });
    expect(rowsOf()).toEqual([{ content: remoteFact.content, valid_to: 1_700_000_500_000, last_updated: 1_700_000_500_000 }]);
  });

  it("ends a fact here when a newer copy elsewhere ended it, and leaves it when the copy is older", () => {
    importOnce([remoteFact]);
    const endedLater = { ...remoteFact, valid_to: 1_700_000_900_000, invalidation_reason: "no longer true", last_updated: 1_700_000_900_000 };
    expect(importOnce([endedLater])).toEqual({ inserted: 0, updated: 1, skipped: 0 });
    expect(rowsOf()[0]).toMatchObject({ valid_to: 1_700_000_900_000 });
    const olderAndLive = { ...remoteFact, last_updated: 1_600_000_000_000 };
    expect(importOnce([olderAndLive])).toEqual({ inserted: 0, updated: 0, skipped: 1 });
    expect(rowsOf()[0]).toMatchObject({ valid_to: 1_700_000_900_000 });
  });
});
