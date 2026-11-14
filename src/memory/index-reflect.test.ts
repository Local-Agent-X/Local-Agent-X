// Reflection adds an opinion's supporting sources once each (index-reflect.ts).
// It used to append every related source on every run, so the same few came
// back thousands of times: one fact held 10,646 entries, 23 of them distinct,
// and the list filled 89% of the 40 MB facts sync file.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema } from "./index-schema.js";
import { migrateSchema } from "./index-schema-migrations.js";
import { reflect, uniqueEvidence, uniqueEvidenceJson } from "./index-reflect.js";

let db: InstanceType<typeof Database>;
let dir: string;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  dir = mkdtempSync(join(tmpdir(), "lax-reflect-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function addFact(kind: string, content: string, sourceFile: string, sourceLine: number, evidenceFor: string[] = []): number {
  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO facts (kind, content, entities, confidence, evidence_for, source_file, source_line, timestamp, last_updated, valid_from)
     VALUES (?, ?, ?, 0.7, ?, ?, ?, ?, ?, ?)`,
  ).run(kind, content, JSON.stringify(["Peter"]), JSON.stringify(evidenceFor), sourceFile, sourceLine, now, now, now);
  db.prepare("INSERT OR IGNORE INTO entity_mentions (fact_id, entity_slug) VALUES (?, 'peter')").run(r.lastInsertRowid);
  return Number(r.lastInsertRowid);
}

const opinionRow = (id: number) =>
  db.prepare("SELECT evidence_for, last_updated FROM facts WHERE id = ?").get(id) as { evidence_for: string; last_updated: number };

const reflectNow = () => reflect(db, dir, () => {}, () => {}, 7);

describe("reflection's evidence for an opinion", () => {
  it("adds each related source once, however many times it runs", async () => {
    const opinion = addFact("opinion", "Peter prefers direct answers", "agent-tool:user-statement", 1);
    addFact("world", "Peter asked for no fluff", "sessions/a.jsonl", 4);
    addFact("world", "Peter cut a long reply short", "sessions/b.jsonl", 9);

    await reflectNow();
    const first = opinionRow(opinion);
    expect(JSON.parse(first.evidence_for)).toEqual(["sessions/a.jsonl#L4", "sessions/b.jsonl#L9"]);

    for (let i = 0; i < 5; i++) await reflectNow();
    const later = opinionRow(opinion);
    expect(later.evidence_for).toBe(first.evidence_for);
    // Nothing new: the row is not touched, so nothing re-exports it either.
    expect(later.last_updated).toBe(first.last_updated);
  });

  it("adds a new source to the list it already has, and heals repeats stored before the fix", async () => {
    const opinion = addFact("opinion", "Peter prefers light mode", "x", 1, ["old.md#L1", "old.md#L1", "old.md#L2", "old.md#L1"]);
    addFact("world", "Peter switched the app to light mode", "sessions/c.jsonl", 3);
    await reflectNow();
    expect(JSON.parse(opinionRow(opinion).evidence_for)).toEqual(["old.md#L1", "old.md#L2", "sessions/c.jsonl#L3"]);
  });
});

describe("uniqueEvidence", () => {
  it("keeps each source once, in the order first seen", () => {
    expect(uniqueEvidence(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });

  it("on a stored column: the text unchanged with no repeat or when it is not a list of sources", () => {
    const clean = JSON.stringify(["a", "b"]);
    expect(uniqueEvidenceJson(clean)).toBe(clean);
    expect(uniqueEvidenceJson(JSON.stringify(["a", "a", "b"]))).toBe(clean);
    for (const odd of ["not json", "{}", "[1,1]", ""]) expect(uniqueEvidenceJson(odd)).toBe(odd);
  });
});

describe("schema v22", () => {
  it("drops repeated sources from every fact's evidence, keeping each distinct one in order", () => {
    const bloated = addFact("opinion", "o", "x", 1, ["s#L1", "s#L2", "s#L1", "s#L1", "s#L2", "t#L3"]);
    const clean = addFact("world", "w", "x", 2, ["s#L1"]);
    const empty = addFact("world", "e", "x", 3);
    const before = opinionRow(clean).evidence_for;

    migrateSchema(db, 21);

    expect(JSON.parse(opinionRow(bloated).evidence_for)).toEqual(["s#L1", "s#L2", "t#L3"]);
    expect(opinionRow(clean).evidence_for).toBe(before);
    expect(opinionRow(empty).evidence_for).toBe("[]");
    // Upkeep, not a change to what memory says: nothing in the change log.
    expect(db.prepare("SELECT COUNT(*) AS n FROM fact_events WHERE op = 'update'").get()).toEqual({ n: 0 });
  });
});
