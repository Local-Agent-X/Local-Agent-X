import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MemoryIndex } from "./index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";
import { installFactEvents, withFactActor, listFactEvents, logPastEnds } from "./fact-events.js";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-fact-events-"));
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
const said = (content: string) => memory.rememberFact(content, { kind: "world", sourceFile: "agent-tool:user-statement" }).fact!.id!;
const row = (id: number) => db().prepare("SELECT valid_to, content, entities FROM facts WHERE id = ?").get(id) as { valid_to: number | null; content: string; entities: string } | undefined;

describe("the memory change log", () => {
  it("records every end with who did it and why, whatever path made it", () => {
    const id = said("@Reta vial is 50 mg with 2 mL bac water");
    memory.invalidateFact(id, { by: "agent", reason: "agent forget" });
    // A raw UPDATE, as a hand-run repair script would do: still recorded.
    const other = said("@Globex is in Ohio");
    db().prepare("UPDATE facts SET valid_to = 1 WHERE id = ?").run(other);

    const [byScript, byAgent] = memory.memoryChanges();
    expect(byAgent).toMatchObject({ factId: id, op: "end", actor: "agent", reason: "agent forget" });
    expect(byAgent.before?.content).toBe("@Reta vial is 50 mg with 2 mL bac water".replace("@", ""));
    expect(byScript).toMatchObject({ factId: other, op: "end", actor: null });
  });

  it("names the job, not the primitive, when a caller says who is acting", () => {
    const id = said("@Acme ships on Fridays");
    withFactActor(db(), "sweep", () => memory.invalidateFact(id, { by: "agent", reason: "x" }));
    expect(memory.memoryChanges()[0].actor).toBe("sweep");
  });

  it("does not log upkeep that changes nothing memory says", () => {
    const id = said("@Acme ships on Fridays");
    const before = listFactEvents(db(), { factId: id }).length;
    db().prepare("UPDATE facts SET last_updated = last_updated + 1, evidence_for = '[1]' WHERE id = ?").run(id);
    expect(listFactEvents(db(), { factId: id }).length).toBe(before);
  });

  it("captures a column a later migration adds", () => {
    const file = join(tempDir, "solo.db");
    const solo = new Database(file);
    solo.exec("CREATE TABLE facts (id INTEGER PRIMARY KEY, kind TEXT, content TEXT, entities TEXT, valid_to INTEGER, invalidation_reason TEXT)");
    installFactEvents(solo);
    solo.exec("ALTER TABLE facts ADD COLUMN subject TEXT");
    installFactEvents(solo);
    solo.prepare("INSERT INTO facts (kind, content, entities, subject) VALUES ('world', 'x', '[]', 'mom')").run();
    expect(listFactEvents(solo, { ops: ["create"] })[0].after?.subject).toBe("mom");
    solo.close();
  });
});

describe("ends made before the log existed", () => {
  it("are logged once on upgrade, dated when they happened, and can be undone", () => {
    const id = said("@Reta vial is 50 mg with 2 mL bac water");
    db().prepare("UPDATE facts SET valid_to = 1700000000000, invalidation_reason = 'superseded by 9 (sweep): semaglutide' WHERE id = ?").run(id);
    db().prepare("DELETE FROM fact_events").run();

    expect(logPastEnds(db())).toBe(1);
    expect(logPastEnds(db())).toBe(0);
    const [ev] = memory.memoryChanges();
    expect(ev).toMatchObject({ factId: id, op: "end", actor: "earlier", at: 1700000000000, reason: "superseded by 9 (sweep): semaglutide" });
    expect(memory.undoMemoryChange(ev.id, "user:undo").ok).toBe(true);
    expect(row(id)!.valid_to).toBeNull();
  });
});

describe("undo", () => {
  it("brings an ended fact back, puts it back on its topic page, and names what replaced it", () => {
    const old = said("@Reta vial is 50 mg with 2 mL bac water");
    const wrong = said("@Reta semaglutide vial is 5 mg");
    memory.invalidateFact(old, { by: "agent", reason: "superseded", replacedBy: wrong });
    const page = join(tempDir, "memory", "bank", "entities", "reta.md");

    const end = memory.memoryChanges({ factId: old, ops: ["end"] })[0];
    const r = memory.undoMemoryChange(end.id, "user:undo");

    expect(r.ok).toBe(true);
    expect(r.message).toContain(`#${wrong}`);
    expect(row(old)!.valid_to).toBeNull();
    expect(memory.memoryChanges({ factId: old })[0]).toMatchObject({ op: "reopen", actor: "user:undo" });
    expect(memory.memoryChanges({ factId: old, ops: ["end"] })[0].undoneBy).not.toBeNull();
    expect(readFileSync(page, "utf8").split("## Earlier")[0]).toContain("50 mg with 2 mL");
    expect(memory.undoMemoryChange(end.id, "user:undo").ok).toBe(false);
  });

  it("restores a deleted row with its keyword and topic links", () => {
    const id = said("@Odalys keeps her sailboat at slip 14");
    withFactActor(db(), "script", () => db().prepare("DELETE FROM facts WHERE id = ?").run(id));
    db().prepare("DELETE FROM entity_mentions WHERE fact_id = ?").run(id);

    const del = memory.memoryChanges({ ops: ["delete"] })[0];
    expect(del.actor).toBe("script");
    expect(memory.undoMemoryChange(del.id, "user:undo").ok).toBe(true);

    expect(row(id)!.content).toContain("slip 14");
    expect(memory.recallByEntity("odalys").map((f) => f.id)).toContain(id);
  });

  it("reverts an in-place change and ends a fact whose creation is undone", () => {
    const id = said("@Acme ships on Fridays");
    db().prepare("UPDATE facts SET content = 'Acme ships on Mondays' WHERE id = ?").run(id);
    const change = memory.memoryChanges({ factId: id, ops: ["change"] })[0];
    expect(memory.undoMemoryChange(change.id, "user:undo").ok).toBe(true);
    expect(row(id)!.content).toContain("Fridays");

    const create = memory.memoryChanges({ factId: id, ops: ["create"] })[0];
    expect(memory.undoMemoryChange(create.id, "user:undo").ok).toBe(true);
    expect(row(id)!.valid_to).not.toBeNull();
  });
});

describe("erasing at the user's request", () => {
  it("is the one delete, keeps no copy of what was said, and is not undoable", () => {
    const id = said("@Odalys keeps her sailboat at slip 14");
    expect(memory.forgetFacts("slip 14")).toBe(1);

    const events = memory.memoryChanges({ factId: id });
    expect(events[0]).toMatchObject({ op: "delete", actor: "user:erase", before: null });
    expect(events.every((e) => e.before === null && e.after === null)).toBe(true);
    expect(JSON.stringify(db().prepare("SELECT * FROM fact_events").all())).not.toContain("slip 14");
    expect(memory.undoMemoryChange(events[0].id, "user:undo").ok).toBe(false);
    expect(existsSync(join(tempDir, "memory", "bank", "entities", "odalys.md"))).toBe(false);
  });
});

describe("a job no person started", () => {
  it("cannot forget or rewrite what the user said, and leaves no second copy trying", () => {
    const id = said("@Reta vial is 50 mg with 2 mL bac water");

    expect(memory.forgetFact("Reta vial", "background")).toMatchObject({ ok: false });
    expect(memory.updateFact("Reta vial", "Reta vial is 5 mg", { sourceFile: "agent-tool", by: "background" })).toMatchObject({ ok: false });

    expect(row(id)!.valid_to).toBeNull();
    expect((db().prepare("SELECT COUNT(*) AS n FROM facts WHERE content LIKE '%5 mg%' AND content NOT LIKE '%50 mg%'").get() as { n: number }).n).toBe(0);
  });

  it("may still tidy what a model wrote on its own account", () => {
    const id = memory.rememberFact("@Acme probably ships on Fridays", { kind: "world", sourceFile: "agent-tool" }).fact!.id!;
    db().prepare("UPDATE facts SET provenance = 'assistant' WHERE id = ?").run(id);
    expect(memory.forgetFact("Acme probably", "background").ok).toBe(true);
    expect(memory.memoryChanges({ factId: id, ops: ["end"] })[0].actor).toBe("background");
  });
});
