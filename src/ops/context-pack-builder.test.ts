/**
 * Memory pre-fetch lifecycle for context packs. Every buildContextPack with a
 * memoryQuery used to open a private MemoryIndex it never closed — one leaked
 * sqlite handle + fs watcher per delegation, and each transient copy stole the
 * universal-index singleton binding from the server's live index. These lock
 * the fixed lifecycle: reuse the process's live index when one exists (left
 * open, binding intact), and open→search→close a transient one otherwise.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../memory/index.js";
import { getUniversalIndex } from "../memory/universal-index.js";
import { buildContextPack } from "./context-pack-builder.js";

let sharedDir: string;
let fallbackDir: string;
let prevLaxDataDir: string | undefined;

beforeEach(() => {
  sharedDir = mkdtempSync(join(tmpdir(), "lax-pack-shared-"));
  fallbackDir = mkdtempSync(join(tmpdir(), "lax-pack-fallback-"));
  // The standalone fallback opens its index at getLaxDir(); point it at a
  // sandbox so the test never touches the real ~/.lax.
  prevLaxDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = fallbackDir;
});

afterEach(() => {
  if (prevLaxDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDataDir;
  try { rmSync(sharedDir, { recursive: true, force: true }); } catch {}
  try { rmSync(fallbackDir, { recursive: true, force: true }); } catch {}
});

// Seeded under the `import/` virtual prefix: the sync sweep (which search
// triggers on a dirty index) purges any files-table path missing on disk
// EXCEPT import/, session-live/ and the session archive.
// BM25 needs corpus contrast: on a near-empty index every term's IDF is ~0,
// so even an exact match scores ~1e-6 and dies at the keyword score floor.
// The filler rows give the target's terms a real IDF.
async function seedSearchableChunk(memory: MemoryIndex, text: string): Promise<void> {
  const chunks = Array.from({ length: 10 }, (_, i) => ({
    path: "import/seed.md", source: "import", startLine: i + 2, endLine: i + 2,
    text: `unrelated corpus filler row ${i} about weather gardening and travel plans`,
    hash: `h-filler-${i}`,
  }));
  chunks.push({ path: "import/seed.md", source: "import", startLine: 1, endLine: 1, text, hash: `h-${text.length}` });
  await memory.indexChunks(chunks, "import/seed.md", "import");
}

describe("context pack memory pre-fetch lifecycle", () => {
  it("reuses the process's live MemoryIndex: hits come from it, it stays open, and the singleton binding is not stolen", async () => {
    const shared = new MemoryIndex(sharedDir);
    try {
      await vi.waitFor(() => expect(getUniversalIndex()?.getMemory()).toBe(shared));
      await seedSearchableChunk(shared, "the sprocket exporter batches orders through the flange queue");

      const pack = await buildContextPack({
        description: "test task",
        memoryQuery: "sprocket flange queue",
      });

      // Hits prove the SHARED index answered — the fallback dir holds nothing.
      expect(pack.context.memoryHits.length).toBeGreaterThan(0);
      expect(shared.isOpen()).toBe(true);
      // Pre-fix, a transient copy re-attached itself here within a tick.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(getUniversalIndex()?.getMemory()).toBe(shared);
    } finally {
      shared.close();
    }
  });

  it("standalone fallback (no live index in the process) opens a transient index and closes it after the search", async () => {
    // Seed the fallback data dir, then close — the process now has no live index.
    const seeded = new MemoryIndex(fallbackDir);
    await vi.waitFor(() => expect(getUniversalIndex()?.getMemory()).toBe(seeded));
    await seedSearchableChunk(seeded, "the gantry loader retries failed manifests overnight");
    seeded.close();
    expect(getUniversalIndex()?.getMemory()?.isOpen()).toBe(false);

    const pack = await buildContextPack({
      description: "test task",
      memoryQuery: "gantry loader manifests",
    });
    expect(pack.context.memoryHits.length).toBeGreaterThan(0);

    // The transient index binds during construction ONLY because nothing open
    // holds the binding here (seeded is closed) — an open live index survives
    // a transient's attach (see universal-index-attach.test.ts). Once the
    // build settles the transient must be CLOSED — an open handle is the leak.
    const bound = await vi.waitFor(() => {
      const m = getUniversalIndex()?.getMemory();
      expect(m && m !== seeded).toBeTruthy();
      return m as MemoryIndex;
    });
    expect(bound.isOpen()).toBe(false);
  });
});
