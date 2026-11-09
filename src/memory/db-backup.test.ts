import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { MemoryIndex } from "./index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";
import { listSnapshots, pruneSnapshots } from "./db-backup.js";

let tempDir: string;
let memory: MemoryIndex;

function open(): MemoryIndex {
  const m = new MemoryIndex(tempDir, { minScore: -1 });
  authorizeTestFactMutations(m);
  return m;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-backup-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = open();
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const db = (m: MemoryIndex) => (m as unknown as { db: InstanceType<typeof Database> }).db;
const said = (m: MemoryIndex, content: string) => m.rememberFact(content, { kind: "world", sourceFile: "agent-tool:user-statement" }).fact!.id!;

describe("daily memory snapshots", () => {
  it("writes one checked snapshot a day, holding the facts and their history", () => {
    said(memory, "@Reta vial is 50 mg with 2 mL bac water");
    said(memory, "@Odalys keeps her sailboat at slip 14");

    const first = memory.snapshotFacts();
    expect(first).toMatchObject({ status: "written", facts: 2 });
    expect(memory.snapshotFacts().status).toBe("exists");
    expect(listSnapshots(join(tempDir, "memory-backups"))).toHaveLength(1);
  });

  it("keeps two weeks of days and one per month for a year", () => {
    const dir = join(tempDir, "memory-backups");
    mkdirSync(dir, { recursive: true });
    const start = new Date(2026, 0, 1);
    for (let i = 0; i < 400; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      writeFileSync(join(dir, `memory-facts-${day}.db.gz`), "");
    }
    pruneSnapshots(dir);
    const left = listSnapshots(dir).map((s) => s.day);
    expect(left.slice(0, 14)).toHaveLength(14);
    expect(new Set(left.map((d) => d.slice(0, 7))).size).toBe(12);
    expect(left.length).toBeLessThanOrEqual(14 + 12);
    expect(readdirSync(dir).length).toBe(left.length);
  });
});

describe("a database that cannot be opened", () => {
  it("is restored from the newest good snapshot instead of starting empty, and says so", () => {
    const id = said(memory, "@Reta vial is 50 mg with 2 mL bac water");
    memory.invalidateFact(id, { by: "agent", reason: "test end" });
    said(memory, "@Odalys keeps her sailboat at slip 14");
    expect(memory.snapshotFacts().status).toBe("written");
    memory.close();

    // Not a database any more.
    for (const f of ["memory.db", "memory.db-wal", "memory.db-shm"]) {
      const p = join(tempDir, f);
      if (existsSync(p)) rmSync(p);
    }
    writeFileSync(join(tempDir, "memory.db"), "this is not a sqlite file ".repeat(200));

    memory = open();
    expect(memory.recovery?.restored).toMatchObject({ facts: 2 });
    expect(existsSync(memory.recovery!.movedTo)).toBe(true);
    expect(memory.recallByEntity("odalys").map((f) => f.content).join()).toContain("slip 14");
    expect(memory.memoryChanges({ factId: id, ops: ["end"] })[0].reason).toBe("test end");
    // Restoring does not log each fact as newly made.
    const creates = db(memory).prepare("SELECT COUNT(*) AS n FROM fact_events WHERE op = 'create'").get() as { n: number };
    expect(creates.n).toBe(2);
    // The change log works on the restored database.
    memory.invalidateFact(id + 1, { by: "agent", reason: "after restore" });
    expect(memory.memoryChanges()[0].reason).toBe("after restore");
  });

  it("never mixes a snapshot into a database that opened fine", () => {
    said(memory, "@Reta vial is 50 mg with 2 mL bac water");
    memory.snapshotFacts();
    memory.close();
    memory = open();
    expect(memory.recovery).toBeNull();
  });
});
