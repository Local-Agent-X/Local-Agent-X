/**
 * A consolidation pass never writes an entity page line without its source.
 *
 * Consolidation reads today's daily log, which never enters the Facts DB. It
 * used to append those lines to entity pages with no source label, and create
 * pages for entities the Facts DB never held; memory_search served them as if
 * they were facts. The page is the Facts DB's alone (updateEntityPage).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryIndex } from "../../index.js";
import { authorizeTestFactMutations } from "../../test-promotion.test-helper.js";
import { TAINTED_FACT_SOURCE_PREFIX } from "../../fact-provenance-label.js";

let tempDir: string;
let memory: MemoryIndex;
let savedDataDir: string | undefined;

const entitiesDir = () => join(tempDir, "memory", "bank", "entities");

function unlabeledPageLines(): string[] {
  return readdirSync(entitiesDir())
    .filter((f) => f.endsWith(".md"))
    .flatMap((f) => readFileSync(join(entitiesDir(), f), "utf8").split("\n").map((line) => `${f}: ${line}`))
    .filter((line) => /^[^:]+: - /.test(line) && !line.includes("[source="));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-consolidation-pages-"));
  mkdirSync(entitiesDir(), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  // The consolidator resolves its daily-log and history paths at module load.
  savedDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = tempDir;
  vi.resetModules();
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  if (savedDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = savedDataDir;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("a consolidation pass and entity pages", () => {
  it("leaves every page line with a source label, and makes no page the Facts DB has no facts for", async () => {
    authorizeTestFactMutations(memory);
    memory.rememberFact("@Acme ships on Fridays", { kind: "world", sourceFile: `${TAINTED_FACT_SOURCE_PREFIX}-user-statement` });
    const today = new Date().toISOString().split("T")[0];
    writeFileSync(join(tempDir, "memory", `${today}.md`), [
      "[10:00:00] W(c=0.90) @Acme has an office in Austin",
      "[10:01:00] W(c=0.90) @Initech is based in Columbus Ohio",
      "",
    ].join("\n"));

    const { runConsolidation } = await import("../../consolidation-pipeline.js");
    // memory_dream runs the consolidate stage alone; the background job runs reflect after it.
    await runConsolidation(memory, { reflect: false, operational: false });
    expect(unlabeledPageLines()).toEqual([]);
    await runConsolidation(memory, { operational: false });
    expect(unlabeledPageLines()).toEqual([]);

    expect(readFileSync(join(entitiesDir(), "acme.md"), "utf8")).toContain("[UNTRUSTED");
    expect(readFileSync(join(entitiesDir(), "acme.md"), "utf8")).not.toContain("Austin");
    expect(existsSync(join(entitiesDir(), "initech.md"))).toBe(false);
  });
});
