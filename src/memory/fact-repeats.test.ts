import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";
import { invalidateFact, repeatsFact } from "./index-facts-invalidate.js";
import { sweepRepeatedFacts } from "./supersede-sweep.js";
import { standsAsHigh } from "./fact-provenance-label.js";

let dir: string;
let memory: MemoryIndex;
const db = () => memory["db"];
const hasFts = () => memory["hasFts"] as boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-fact-repeats-"));
  mkdirSync(join(dir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(dir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(dir, { minScore: -1 });
  authorizeTestFactMutations(memory);
});

afterEach(() => {
  try { memory.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

/** A stored fact as an older save left it (the remember guard would refuse a repeat). */
function stored(content: string, at: number, opts: { provenance?: string | null; sourceFile?: string } = {}): number {
  const id = db().prepare(
    `INSERT INTO facts (kind, content, entities, confidence, evidence_for, evidence_against, source_file, source_line, timestamp, last_updated, provenance)
     VALUES ('observation', ?, '[]', 1, '[]', '[]', ?, 0, ?, ?, ?)`,
  ).run(content, opts.sourceFile ?? "agent-tool", at, at, opts.provenance === undefined ? "assistant" : opts.provenance).lastInsertRowid as number;
  if (hasFts()) db().prepare("INSERT INTO facts_fts (rowid, content) VALUES (?, ?)").run(id, content);
  return id;
}

const current = (id: number) => (db().prepare("SELECT valid_to FROM facts WHERE id = ?").get(id) as { valid_to: number | null }).valid_to === null;
const count = () => (db().prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n;

describe("what counts as a repeat", () => {
  it("is a statement an older fact fully says", () => {
    expect(repeatsFact("User likes tea", { content: "User likes green tea" })).toBe(true);
    // Live pair, 2026-11-13.
    expect(repeatsFact(
      "Peter thinks of Primal as his friend and buddy rather than just an automated app.",
      { content: "Peter thinks of Primal as his friend and buddy rather than just an automated app, and has pushed back when other people told him otherwise" },
    )).toBe(true);
  });

  it("is never a statement with one word swapped, a different number, or a negation", () => {
    expect(repeatsFact("Peter's son likes Dumbo rides", { content: "Peter's son hates Dumbo rides" })).toBe(false);
    // Two items of one list, which a dry run on live memory ended as one (2026-11-13).
    expect(repeatsFact(
      "Nutrishop Ops Dashboard (2026-04-28) — Best quote-shopping targets for bad credit: Bond911",
      { content: "Nutrishop Ops Dashboard (2026-04-28) — Best quote-shopping targets for bad credit: Bryant Surety Bonds" },
    )).toBe(false);
    expect(repeatsFact("User drew 30 units", { content: "User drew 25 units" })).toBe(false);
    expect(repeatsFact("User does not drink coffee", { content: "User does drink coffee" })).toBe(false);
  });

  it("never drops the user's word for a model's, nor a clean source for a tainted one", () => {
    const user = { provenance: "user_statement", sourceFile: "agent-tool:user-statement" };
    const model = { provenance: "assistant", sourceFile: "agent-tool" };
    const tainted = { provenance: "assistant", sourceFile: "agent-tool:tainted-external-inference" };
    expect(standsAsHigh(user, model)).toBe(true);
    expect(standsAsHigh(model, user)).toBe(false);
    expect(standsAsHigh(tainted, model)).toBe(false);
    expect(standsAsHigh(model, tainted)).toBe(true);
  });
});

describe("remember saves nothing a current fact already says", () => {
  it("answers with the fact that said it and adds no row", () => {
    const first = memory.rememberFact("User drinks black coffee every morning");
    expect(first.ok && !first.alreadySaved).toBe(true);
    const rows = count();
    const again = memory.rememberFact("User drinks black coffee every morning before work".replace(" before work", ""));
    expect(again).toMatchObject({ ok: true, alreadySaved: true });
    expect(again.fact!.id).toBe(first.fact!.id);
    expect(count()).toBe(rows);
  });

  it("still saves a statement that adds to the fact", () => {
    memory.rememberFact("User drinks black coffee");
    const more = memory.rememberFact("User drinks black coffee with oat milk on weekends");
    expect(more.alreadySaved).toBeFalsy();
    expect(more.newFactId).toBeDefined();
  });
});

describe("the repeat sweep ends later copies", () => {
  it("ends the newer copy as a repeat of the older one, which stays", async () => {
    const older = stored("Peter wants headless game testing while GPU evaluations run", 1_000);
    const newer = stored("Peter wants headless game testing while the GPU evaluations run", 2_000);
    const r = await sweepRepeatedFacts(db(), hasFts(), 50);
    expect(r.ended.map((f) => f.id)).toEqual([newer]);
    expect(current(older)).toBe(true);
    expect(current(newer)).toBe(false);
    const row = db().prepare("SELECT invalidated_by FROM facts WHERE id = ?").get(newer) as { invalidated_by: number };
    expect(row.invalidated_by).toBe(older);
  });

  it("keeps the user's own statement when the older copy is only the model's", async () => {
    stored("Peter graduated from Cal State East Bay in 2019", 1_000, { provenance: "assistant" });
    const users = stored("Peter graduated from Cal State East Bay in 2019.", 2_000, { provenance: "user_statement", sourceFile: "agent-tool:user-statement" });
    expect((await sweepRepeatedFacts(db(), hasFts(), 50)).ended).toEqual([]);
    expect(current(users)).toBe(true);
  });

  it("leaves a short fact with one word swapped", async () => {
    stored("Peter's son likes Dumbo rides", 1_000);
    const hates = stored("Peter's son hates Dumbo rides", 2_000);
    await sweepRepeatedFacts(db(), hasFts(), 50);
    expect(current(hates)).toBe(true);
  });

  it("works through everything stored once, then only new saves", async () => {
    for (let i = 0; i < 6; i++) stored(`Peter keeps a ledger of supplement orders number ${i}`, 1_000 + i);
    const first = await sweepRepeatedFacts(db(), hasFts(), 4);
    expect(first.examined).toBe(4);
    expect(first.backlogLeft).toBe(true);
    const second = await sweepRepeatedFacts(db(), hasFts(), 4);
    expect(second.examined).toBe(2);
    expect(second.backlogLeft).toBe(false);
    expect((await sweepRepeatedFacts(db(), hasFts(), 4)).examined).toBe(0);
  });

  it("is refused by invalidateFact when the kept fact does not say it", async () => {
    const a = stored("Peter lives in McKinney Texas", 1_000);
    const b = stored("Peter owns a supplement store", 2_000);
    expect(invalidateFact(db(), b, { by: "repeat", replacedBy: a })).toBe(false);
    expect(current(b)).toBe(true);
  });
});
