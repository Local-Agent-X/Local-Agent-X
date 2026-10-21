/**
 * The retention sweep (archiveOldFacts) hard-deletes facts. The entity pages
 * built from them are what memory_search returns, so the sweep rebuilds each
 * affected page from the Facts DB (updateEntityPage, the one page writer) and
 * removes the page of an entity with no facts left, as forgetFacts does.
 * Without that, a page kept serving a deleted fact until some other fact for
 * the same entity changed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { MemoryIndex } from "../memory/index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";
import { archiveOldFacts } from "./index-watcher.js";
import { syncIndex } from "./index-sync.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-archive-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
  authorizeTestFactMutations(memory);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const internals = () => memory as unknown as { db: InstanceType<typeof Database>; hasFts: boolean };
const entitiesDir = () => join(tempDir, "memory", "bank", "entities");
const pagePath = (slug: string) => join(entitiesDir(), `${slug}.md`);

function remember(content: string): number {
  const r = memory.rememberFact(content, { kind: "world", sourceFile: "agent-tool:user-statement" });
  expect(r.ok).toBe(true);
  return r.fact!.id!;
}

/** Push a fact past the retention window. */
function age(id: number): void {
  const old = Date.now() - (memory.getConfig().factRetentionDays + 1) * DAY_MS;
  internals().db.prepare("UPDATE facts SET timestamp = ? WHERE id = ?").run(old, id);
}

function archive(): { rebuilt: string[]; dirtied: boolean } {
  let dirtied = false;
  const rebuilt = archiveOldFacts(internals().db, memory.getConfig(), internals().hasFts, entitiesDir(),
    () => { dirtied = true; });
  return { rebuilt, dirtied };
}

describe("archiveOldFacts keeps entity pages in step with the Facts DB", () => {
  it("drops an archived fact's line from its entity page and keeps the rest", () => {
    age(remember("@Acme ships on Fridays"));
    remember("@Acme has an office in Austin");
    expect(readFileSync(pagePath("acme"), "utf8")).toContain("ships on Fridays");

    const { rebuilt, dirtied } = archive();

    const page = readFileSync(pagePath("acme"), "utf8");
    expect(page).not.toContain("ships on Fridays");
    expect(page).toContain("has an office in Austin");
    expect(rebuilt).toEqual(["acme"]);
    expect(dirtied).toBe(true);
  });

  it("removes the page when the entity's last fact is archived", () => {
    age(remember("@Globex is in Ohio"));
    expect(existsSync(pagePath("globex"))).toBe(true);

    const { rebuilt, dirtied } = archive();

    expect(existsSync(pagePath("globex"))).toBe(false);
    expect(rebuilt).toEqual([]);
    expect(dirtied).toBe(true);
  });

  it("leaves pages alone when nothing is past retention", () => {
    remember("@Initech is based in Texas");
    const before = readFileSync(pagePath("initech"), "utf8");

    expect(archive()).toEqual({ rebuilt: [], dirtied: false });
    expect(readFileSync(pagePath("initech"), "utf8")).toBe(before);
  });

  it("sync re-indexes the rebuilt pages one at a time", async () => {
    age(remember("@Acme ships on Fridays"));
    remember("@Acme has an office in Austin");
    age(remember("@Globex ships on Mondays"));
    remember("@Globex is in Ohio");

    const indexed: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await syncIndex({
      db: internals().db,
      embeddingProvider: null,
      config: memory.getConfig(),
      hasFts: internals().hasFts,
      hasVec: false,
      memoryDir: memory.getMemoryDir(),
      dataDir: memory.getDataDir(),
      entitiesDir: entitiesDir(),
      reindexEntity: async (slug) => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        indexed.push(slug);
        inFlight--;
      },
      sessionDeltas: new Map(),
      dirtyRef: { value: true },
      syncInProgressRef: { value: false },
    });

    expect(indexed.sort()).toEqual(["acme", "globex"]);
    expect(maxInFlight).toBe(1);
    expect(readFileSync(pagePath("globex"), "utf8")).not.toContain("ships on Mondays");
  });
});
