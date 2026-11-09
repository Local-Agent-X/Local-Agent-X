/**
 * Upkeep never deletes a fact. A retention sweep used to run on every index
 * sync and delete every fact saved more than 365 days ago, current or not,
 * and every opinion below 0.1 confidence; a background job purged ended facts
 * after 30 days (memory audit 2026-11-08). Both are gone: a fact leaves the
 * database only at the user's explicit request (memory_forget).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { MemoryIndex } from "../memory/index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-keep-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
  authorizeTestFactMutations(memory);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const db = () => (memory as unknown as { db: InstanceType<typeof Database> }).db;
const exists = (id: number) => db().prepare("SELECT 1 FROM facts WHERE id = ?").get(id) !== undefined;

describe("index sync keeps every fact", () => {
  it("keeps a two-year-old fact, an ended fact and a low-confidence opinion", async () => {
    const old = memory.rememberFact("@Initech is based in Texas", { kind: "world", sourceFile: "agent-tool:user-statement" }).fact!.id!;
    db().prepare("UPDATE facts SET timestamp = ? WHERE id = ?").run(Date.now() - 2 * YEAR_MS, old);
    const ended = memory.rememberFact("@Globex is in Ohio", { kind: "world", sourceFile: "agent-tool:user-statement" }).fact!.id!;
    memory.invalidateFact(ended, { by: "agent", reason: "test" });
    db().prepare("UPDATE facts SET valid_to = ? WHERE id = ?").run(Date.now() - YEAR_MS, ended);
    const opinion = memory.rememberFact("@Acme coffee is fine", { kind: "opinion", confidence: 0.05, sourceFile: "agent-tool" }).fact!.id!;

    memory.markDirty();
    await memory.sync();

    expect([old, ended, opinion].map(exists)).toEqual([true, true, true]);
    const deletes = db().prepare("SELECT COUNT(*) AS n FROM fact_events WHERE op = 'delete'").get() as { n: number };
    expect(deletes.n).toBe(0);
  });
});
