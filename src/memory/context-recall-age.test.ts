/**
 * Integration tests for relative-age + stale-caveat rendering in
 * autoSearchContext (the associative-recall prompt formatter).
 *
 * The staleness clock is the chunk's DB `updated_at` — when that snippet's
 * content last changed — NOT the source file's mtime. Consolidation appends
 * bump a whole entity page's mtime nightly while its old facts stay old, so
 * mtime would render 6-month-old facts as "just now"; per-chunk updated_at is
 * immune (indexChunksIdempotent only re-stamps changed chunks) and also works
 * for virtual paths (session-live/…, import/…) that have no file to stat.
 *
 * No embedding provider is set, so search runs keyword-only (FTS). textWeight
 * is set to 0 so the keyword-only relaxed score floor admits matches on a
 * tiny test corpus, where BM25 scores saturate near 0.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { autoSearchContext } from "./context.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const QUERY = "bambu printer hardened nozzles carbon fiber";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-recall-age-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  mkdirSync(join(tempDir, "sessions"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1, textWeight: 0 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

/**
 * Seed one searchable entity chunk, let the search-triggered sync index it,
 * then force its updated_at to `ageMs` ago. The follow-up sync inside
 * autoSearchContext leaves it alone (unchanged hash → chunk not re-stamped),
 * which is exactly the production invariant this feature rides on.
 */
async function seedChunkAgedBy(ageMs: number): Promise<void> {
  writeFileSync(
    join(tempDir, "memory", "bank", "entities", "bambu.md"),
    "# Bambu\n\n## Facts\n\n- The bambu printer uses hardened nozzles for carbon fiber filament.\n",
    "utf-8",
  );
  // Force the initial index pass so the chunk row exists to backdate.
  await memory.search(QUERY, { maxResults: 5 });
  const changed = memory["db"]
    .prepare("UPDATE chunks SET updated_at = ?")
    .run(Date.now() - ageMs).changes;
  expect(changed).toBeGreaterThan(0);
}

describe("autoSearchContext relative age + stale caveat", () => {
  it("renders an old snippet with a relative-age token and the stale caveat", async () => {
    await seedChunkAgedBy(3 * DAY_MS);

    const out = await autoSearchContext(memory, QUERY);

    expect(out).toContain("RELEVANT MEMORIES");
    expect(out).toContain("bambu");
    // Relative age from chunk updated_at — never a raw stamp.
    expect(out).toContain("3 days ago");
    // >24h old → citation-drift caveat.
    expect(out).toContain("may be outdated");
  });

  it("renders a fresh snippet with relative age and NO stale caveat", async () => {
    await seedChunkAgedBy(2 * HOUR_MS);

    const out = await autoSearchContext(memory, QUERY);

    expect(out).toContain("RELEVANT MEMORIES");
    expect(out).toContain("2 hours ago");
    expect(out).not.toContain("may be outdated");
  });
});
