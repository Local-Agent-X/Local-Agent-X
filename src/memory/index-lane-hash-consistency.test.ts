/**
 * Regression: files-table hash consistency across the two index lanes.
 *
 * The idempotent write-through lane (UniversalIndex → indexChunksIdempotent,
 * section chunks) used to stamp files.hash = "idempotent:<ts>", which could
 * NEVER match the sync lane's "<mtimeMs>:<size>" format (listMemoryFiles) —
 * so the next search-triggered syncIndex treated every idempotent-indexed
 * file as changed and re-ran indexFile. That caused (a) perpetual re-chunk +
 * re-embed churn on untouched files, and (b) a staleness-clock wipe: indexFile
 * re-chunks with different geometry (1600-char windows vs sections), so on a
 * page larger than one window a section chunk straddling a window boundary
 * matches nothing in the clock-preservation snapshot and re-stamps to now —
 * a 90-day-old fact renders "just now" in the recall formatter.
 *
 * Fix: indexChunksIdempotent stats REAL on-disk files and stamps the sync
 * lane's own "<mtimeMs>:<size>" format, so an untouched file is skipped by
 * sync entirely. Virtual paths (import/…, session-live/…) keep the opaque
 * stamp. NOTE (documented latent limitation, Wave-2): the chunker-geometry
 * divergence itself remains — a page that IS touched on disk after a
 * write-through still crosses lanes and can re-stamp clocks on large pages;
 * the real fix is one chunker per path class.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { UniversalIndex } from "./universal-index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-recall-skeptic2-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "sessions"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1, textWeight: 0 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

it("large entity page: idempotent-lane clocks survive the next sync reindex", async () => {
  const page = join(tempDir, "memory", "bank", "entities", "bambu.md");
  // ~4.5KB page, several sections, each section well under one 1600-char
  // window but the PAGE spans ~3 windows, so some section straddles a boundary.
  const filler = (tag: string) =>
    Array.from({ length: 12 }, (_, i) => `- ${tag} fact line ${i} with some padding text to reach realistic length.`).join("\n");
  const content =
    `# Bambu\n\n## Nozzles\n\n- The bambu printer uses hardened nozzles for carbon fiber filament.\n${filler("nozzle")}\n\n` +
    `## Plates\n\n${filler("plate")}\n\n## Filament\n\n${filler("filament")}\n\n## Firmware\n\n${filler("firmware")}\n\n## Slicer\n\n${filler("slicer")}\n`;
  writeFileSync(page, content, "utf-8");

  // Consolidation write-through lane: chunkBySections + idempotent insert.
  const uni = new UniversalIndex(memory);
  await uni.indexEntityPage("bambu");

  // Age every fact 90 days.
  const db = memory["db"];
  const backdated = db.prepare("UPDATE chunks SET updated_at = ?").run(Date.now() - 90 * DAY_MS).changes;
  expect(backdated).toBeGreaterThan(0);

  // Next user message → search → sync. files.hash is "idempotent:<ts>" which
  // mismatches listMemoryFiles' "<mtimeMs>:<size>" → full indexFile reindex.
  memory.markDirty();
  await memory.search("bambu printer hardened nozzles carbon fiber", { maxResults: 5 });

  const rows = db.prepare("SELECT updated_at FROM chunks WHERE path = ?").all(page) as Array<{ updated_at: number }>;
  expect(rows.length).toBeGreaterThan(1);
  const fresh = rows.filter((r) => Date.now() - r.updated_at < DAY_MS);
  // NO chunk of this untouched-on-disk page may read as fresh.
  expect(fresh.length).toBe(0);
});
