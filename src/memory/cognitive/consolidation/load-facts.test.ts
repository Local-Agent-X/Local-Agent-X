// The nightly consolidation reads the facts DB for what recurs. It must see
// what the memory index itself calls current: a fact the user forgot or
// corrected is not one, and its text must not be copied into the report.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { MemoryIndex } from "../../index.js";
import { authorizeTestFactMutations } from "../../test-promotion.test-helper.js";
import { loadSqliteFacts } from "./load-facts.js";

let dataDir = "";
let memory: MemoryIndex;
const previous = process.env.LAX_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-load-facts-"));
  mkdirSync(join(dataDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(dataDir, "memory", "session-summaries"), { recursive: true });
  process.env.LAX_DATA_DIR = dataDir;
  memory = new MemoryIndex(dataDir, { minScore: -1 });
  authorizeTestFactMutations(memory);
});

afterEach(() => {
  try { memory.close(); } catch { /* already closed */ }
  if (previous === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previous;
  rmSync(dataDir, { recursive: true, force: true });
});

const db = () => (memory as unknown as { db: InstanceType<typeof Database> }).db;
const said = (content: string) => memory.rememberFact(content, { kind: "world", sourceFile: "agent-tool:user-statement" }).fact!.id!;

describe("loadSqliteFacts", () => {
  it("returns the current facts with their first entity, and none that were ended", () => {
    said("@Odalys keeps her sailboat at slip 14");
    const ended = said("@Acme ships on Fridays");
    db().prepare("UPDATE facts SET valid_to = ?, invalidation_reason = 'corrected' WHERE id = ?").run(Date.now(), ended);

    const facts = loadSqliteFacts(30);
    expect(facts.map((f) => f.content)).toEqual([expect.stringContaining("slip 14")]);
    expect(facts[0]).toMatchObject({ entity: expect.stringMatching(/odalys/i), accessCount: 1 });
  });

  it("reads every current fact in the window, not a page of them", () => {
    for (let i = 0; i < 60; i++) said(`@Odalys logged sailing trip number ${i} to the far marker`);
    expect(loadSqliteFacts(30)).toHaveLength(60);
  });

  it("leaves out facts older than the window", () => {
    const old = said("@Odalys bought the sailboat in spring");
    db().prepare("UPDATE facts SET timestamp = ? WHERE id = ?").run(Date.now() - 40 * 24 * 60 * 60 * 1000, old);
    expect(loadSqliteFacts(30)).toEqual([]);
  });
});
