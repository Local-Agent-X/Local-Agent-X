/**
 * purgeInvalidatedFacts — GC for the bitemporal facts store.
 *
 * invalidateFact only soft-deletes (sets valid_to) so a superseded fact stays
 * queryable via recallAsOf during a grace window. Nothing ever hard-removed
 * those rows, so they accumulated forever. purgeInvalidatedFacts reclaims rows
 * invalidated longer ago than the retention window, cascading the FTS mirror,
 * entity_mentions, entity_relations, and the content-keyed embedding cache the
 * same way forgetFacts does.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MemoryIndex } from "../memory/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-purge-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function db(): InstanceType<typeof import("better-sqlite3")> {
  return (memory as unknown as { db: InstanceType<typeof import("better-sqlite3")> }).db;
}

function factExists(id: number): boolean {
  return !!db().prepare("SELECT 1 FROM facts WHERE id = ?").get(id);
}

function entityMentionCount(id: number): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM entity_mentions WHERE fact_id = ?").get(id) as { n: number }).n;
}

function ftsCount(id: number): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM facts_fts WHERE rowid = ?").get(id) as { n: number }).n;
}

// invalidateFact stamps valid_to with Date.now(); to simulate facts that were
// invalidated long ago vs recently, backdate valid_to directly.
function setValidTo(id: number, validTo: number): void {
  db().prepare("UPDATE facts SET valid_to = ? WHERE id = ?").run(validTo, id);
}

describe("purgeInvalidatedFacts", () => {
  it("deletes long-invalidated facts + their FTS/entity rows, keeps recent + valid", () => {
    const now = Date.now();

    // OLD invalidated fact with an @-entity (so it has an entity_mention + FTS row).
    const oldFact = memory.rememberFact("user once used @vim as their editor", {
      kind: "observation",
      confidence: 0.8,
    });
    expect(oldFact.ok).toBe(true);
    const oldId = oldFact.fact!.id!;
    expect(entityMentionCount(oldId)).toBeGreaterThan(0);
    memory.invalidateFact(oldId, { reason: "switched editors" });
    setValidTo(oldId, now - 40 * DAY_MS); // invalidated 40d ago — past 30d retention

    // RECENTLY invalidated fact — inside the retention window, must survive.
    const recentFact = memory.rememberFact("user is trying @emacs this week", {
      kind: "observation",
      confidence: 0.8,
    });
    expect(recentFact.ok).toBe(true);
    const recentId = recentFact.fact!.id!;
    memory.invalidateFact(recentId, { reason: "experiment ended" });
    setValidTo(recentId, now - 5 * DAY_MS); // invalidated 5d ago — within window

    // VALID fact — never invalidated, must survive.
    const liveFact = memory.rememberFact("user prefers @vscode now", {
      kind: "observation",
      confidence: 0.9,
    });
    expect(liveFact.ok).toBe(true);
    const liveId = liveFact.fact!.id!;

    const deleted = memory.purgeInvalidatedFacts(RETENTION_MS);

    expect(deleted).toBe(1);
    // Old invalidated fact and its dependent rows are gone.
    expect(factExists(oldId)).toBe(false);
    expect(entityMentionCount(oldId)).toBe(0);
    expect(ftsCount(oldId)).toBe(0);
    // Recently invalidated fact is retained (still recallable as-of its window).
    expect(factExists(recentId)).toBe(true);
    // Valid fact untouched.
    expect(factExists(liveId)).toBe(true);
  });

  it("removes the content-keyed embedding_cache entry for a purged fact", () => {
    const now = Date.now();
    const content = "user briefly liked teal as an accent color";
    const r = memory.rememberFact(content, { kind: "opinion", confidence: 0.7 });
    expect(r.ok).toBe(true);
    const id = r.fact!.id!;

    // rememberFact strips no @-entities here, so the persisted content equals
    // the input; seed an embedding_cache row keyed by its sha256, mirroring how
    // the embedding layer keys cached vectors.
    const hash = createHash("sha256").update(r.fact!.content).digest("hex");
    db()
      .prepare("INSERT INTO embedding_cache (hash, provider, model, embedding, updated_at) VALUES (?, 'default', 'default', '[]', ?)")
      .run(hash, now);
    expect(db().prepare("SELECT COUNT(*) AS n FROM embedding_cache WHERE hash = ?").get(hash)).toEqual({ n: 1 });

    memory.invalidateFact(id, { reason: "color phase over" });
    setValidTo(id, now - 60 * DAY_MS);

    const deleted = memory.purgeInvalidatedFacts(RETENTION_MS);
    expect(deleted).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS n FROM embedding_cache WHERE hash = ?").get(hash)).toEqual({ n: 0 });
  });

  it("returns 0 and changes nothing when no fact is past the retention window", () => {
    const now = Date.now();
    const r = memory.rememberFact("a recently invalidated fact", { kind: "observation", confidence: 0.5 });
    expect(r.ok).toBe(true);
    memory.invalidateFact(r.fact!.id!, { reason: "recent" });
    setValidTo(r.fact!.id!, now - 1 * DAY_MS);

    const before = memory.validityStats();
    const deleted = memory.purgeInvalidatedFacts(RETENTION_MS);
    expect(deleted).toBe(0);
    expect(memory.validityStats()).toEqual(before);
    expect(factExists(r.fact!.id!)).toBe(true);
  });
});
