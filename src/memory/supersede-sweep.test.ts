import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { MemoryIndex } from "./index.js";
import { resolveFact } from "./resolver.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";
import { sweepSupersededFacts, type Resolve } from "./supersede-sweep.js";

vi.mock("./resolver.js", () => ({ resolveFact: vi.fn(async () => ({ op: "ADD", reason: "x" })) }));

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-supersede-"));
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
const hasFts = () => (memory as unknown as { hasFts: boolean }).hasFts;

/** A stored fact, as the user said it (or as a model wrote it), saved at `at`. */
function stored(content: string, at: number, provenance: "user_statement" | "assistant" = "user_statement"): number {
  const [f] = memory.retain(`- O ${content}`, provenance === "user_statement" ? "agent-tool:user-statement" : "agent-tool");
  db().prepare("UPDATE facts SET timestamp = ?, provenance = ? WHERE id = ?").run(at, provenance, f.id!);
  return f.id!;
}
const row = (id: number) => db().prepare("SELECT valid_to, invalidated_by FROM facts WHERE id = ?").get(id) as { valid_to: number | null; invalidated_by: number | null };

/** A resolver that judges `newer` to replace `older` and adds everything else. */
const replaces = (newer: string, older: number): Resolve => async (content, candidates) =>
  content.includes(newer) && candidates.some((c) => c.id === older)
    ? { op: "UPDATE", targetId: older, reason: "new vial" }
    : { op: "ADD", reason: "unrelated" };

describe("sweepSupersededFacts — stored facts keep memory current on their own", () => {
  it("ends a stored fact that a newer stored statement of the user's replaces, recording the replacement", async () => {
    // 2026-11-04: the May and October retatrutide vials were both current.
    const may = stored("Peter's retatrutide vial is 20 mg with 1 mL bac water", 1_000);
    const october = stored("Peter's retatrutide vial is now 50 mg with 2 mL bac water", 2_000);

    const r = await sweepSupersededFacts(db(), hasFts(), replaces("50 mg", may), 10);

    expect(r.ended.map((f) => f.id)).toEqual([may]);
    expect(row(may).valid_to).not.toBeNull();
    expect(row(may).invalidated_by).toBe(october);
    expect(row(october).valid_to).toBeNull();
  });

  it("never offers the resolver a fact newer than the one it is examining", async () => {
    stored("Peter's retatrutide vial is 20 mg with 1 mL bac water", 1_000);
    const october = stored("Peter's retatrutide vial is now 50 mg with 2 mL bac water", 2_000);
    const resolve = vi.fn<Resolve>(async () => ({ op: "ADD", reason: "x" }));

    await sweepSupersededFacts(db(), hasFts(), resolve, 10);

    for (const [content, candidates] of resolve.mock.calls) {
      if (content.includes("20 mg")) expect(candidates.map((c) => c.id)).not.toContain(october);
    }
  });

  it("a model's newer inference does not end what the user said", async () => {
    const said = stored("Peter's retatrutide vial is 20 mg with 1 mL bac water", 1_000);
    stored("Peter probably switched his retatrutide vial to 50 mg", 2_000, "assistant");

    await sweepSupersededFacts(db(), hasFts(), replaces("probably", said), 10);

    expect(row(said).valid_to).toBeNull();
  });

  it("works through the backlog across runs, then takes only facts saved since", async () => {
    for (let i = 0; i < 5; i++) stored(`Peter note number ${i} about topic ${i}`, 1_000 + i);
    const resolve = vi.fn<Resolve>(async () => ({ op: "ADD", reason: "x" }));

    const first = await sweepSupersededFacts(db(), hasFts(), resolve, 3);
    expect(first.examined).toBe(3);
    expect(first.backlogLeft).toBe(true);
    const second = await sweepSupersededFacts(db(), hasFts(), resolve, 3);
    expect(second.examined).toBe(2);
    expect(second.backlogLeft).toBe(false);
    expect((await sweepSupersededFacts(db(), hasFts(), resolve, 3)).examined).toBe(0);

    stored("Peter note added later", 9_000);
    expect((await sweepSupersededFacts(db(), hasFts(), resolve, 3)).examined).toBe(1);
  });

  it("the replaced fact stays on its entity page as history", async () => {
    const may = memory.rememberFact("@Retatrutide vial is 20 mg with 1 mL bac water", { kind: "observation", sourceFile: "agent-tool:user-statement" }).fact!.id!;
    const october = memory.rememberFact("@Retatrutide vial is now 50 mg with 2 mL bac water", { kind: "observation", sourceFile: "agent-tool:user-statement" }).fact!.id!;
    db().prepare("UPDATE facts SET timestamp = 1000 WHERE id = ?").run(may);
    db().prepare("UPDATE facts SET provenance = 'user_statement' WHERE id IN (?, ?)").run(may, october);
    vi.mocked(resolveFact).mockImplementation(replaces("50 mg", may));

    const r = await memory.sweepSupersededFacts(10);

    expect(r.replaced).toBe(1);
    expect(row(may).invalidated_by).toBe(october);
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(join(tempDir, "memory", "bank", "entities", "retatrutide.md"), "utf8");
    expect(page.slice(page.indexOf("## Earlier (replaced"))).toContain("20 mg with 1 mL");
  });
});
