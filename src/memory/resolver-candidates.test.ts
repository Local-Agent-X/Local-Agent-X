import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { MemoryIndex } from "./index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";
import { findResolverCandidates } from "./resolver-candidates.js";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-resolver-cand-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
  authorizeTestFactMutations(memory);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const db = () => (memory as unknown as { db: InstanceType<typeof Database>; hasFts: boolean }).db;
const hasFts = () => (memory as unknown as { hasFts: boolean }).hasFts;
const remember = (content: string) => memory.rememberFact(content, { kind: "observation" }).fact!.id!;
const setSavedAt = (id: number, at: number) => db().prepare("UPDATE facts SET timestamp = ? WHERE id = ?").run(at, id);

describe("findResolverCandidates", () => {
  it("finds an old fact on the same subject even when the shared entity is the user, tagged on everything", () => {
    // 2026-11-04: every fact was tagged "peter", so the candidates were the
    // user's five newest facts on any subject and the old vial never showed.
    const vial = remember("@Peter mixes his retatrutide vial: 20 mg with 1 mL bacteriostatic water");
    for (const topic of ["coffee order", "gym schedule", "favorite color", "car model", "phone plan", "dog breed", "work shift"]) {
      remember(`@Peter mentioned his ${topic} today`);
    }
    const found = findResolverCandidates(db(), hasFts(), "Peter now uses a 50 mg retatrutide vial with 2 mL bacteriostatic water", ["peter"], 5);
    expect(found.map((c) => c.id)).toContain(vial);
  });

  it("with olderThan, offers only facts saved at or before that time, and never the statement itself", () => {
    const may = remember("@Peter retatrutide vial is 20 mg with 1 mL water");
    const october = remember("@Peter retatrutide vial is 50 mg with 2 mL water");
    setSavedAt(may, 1_000);
    setSavedAt(october, 2_000);
    const ids = findResolverCandidates(db(), hasFts(), "Peter retatrutide vial is 50 mg with 2 mL water", ["peter"], 5, { olderThan: 2_000, excludeId: october }).map((c) => c.id);
    expect(ids).toEqual([may]);
    expect(findResolverCandidates(db(), hasFts(), "Peter retatrutide vial", ["peter"], 5, { olderThan: 1_500 }).map((c) => c.id)).toEqual([may]);
  });
});
