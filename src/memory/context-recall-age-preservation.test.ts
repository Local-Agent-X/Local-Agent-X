/**
 * Regression: chunk clocks survive the sync-lane full re-index.
 *
 * indexFile (index-sync.ts) drops and reinserts every chunk of a file whose
 * files.hash (mtimeMs:size) changed. Before the clock-preservation snapshot,
 * that re-stamped ALL chunks with updated_at = Date.now() — so consolidation's
 * nightly appendFileSync on an entity page made a 90-day-old fact render
 * "just now" in the recall formatter and permanently suppressed the stale
 * caveat on exactly the long-lived pages most likely to hold rotted
 * references. Unchanged content (same content_hash) must keep its original
 * updated_at across the drop-and-reinsert; only new/changed content gets now.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { autoSearchContext } from "./context.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const QUERY = "bambu printer hardened nozzles carbon fiber";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-recall-skeptic-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "sessions"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1, textWeight: 0 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

it("old fact keeps its age after a consolidation-style append to the entity page", async () => {
  const page = join(tempDir, "memory", "bank", "entities", "bambu.md");
  writeFileSync(page, "# Bambu\n\n## Facts\n\n- The bambu printer uses hardened nozzles for carbon fiber filament.\n", "utf-8");
  await memory.search(QUERY, { maxResults: 5 });
  const backdated = memory["db"].prepare("UPDATE chunks SET updated_at = ?").run(Date.now() - 90 * DAY_MS).changes;
  expect(backdated).toBeGreaterThan(0);

  // Nightly consolidation appends a new section (write.ts appendFileSync).
  appendFileSync(page, "\n## Update\n\n- Unrelated new note about spool humidity.\n", "utf-8");
  // Ensure the watcher/sync sees a changed hash (mtimeMs:size) and mark dirty
  // like the fs watcher would.
  utimesSync(page, new Date(), new Date());
  memory.markDirty();

  const out = await autoSearchContext(memory, QUERY);
  expect(out).toContain("bambu");
  // The 90-day-old fact must NOT read as fresh after the append.
  expect(out).toContain("90 days ago");
  expect(out).toContain("may be outdated");
  expect(out).not.toContain("just now");
});
