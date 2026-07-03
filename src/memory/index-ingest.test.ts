/**
 * Ingest must not silently swallow embedding failures. embedChunksWithRetry
 * RESOLVES (it doesn't throw) when the provider is down — it exhausts its
 * retries and returns no vectors — so indexChunks inserts the chunks with a
 * NULL embedding and the caller then marks the conversation ingested. Import a
 * whole history with Ollama down and the entire import becomes vector-invisible
 * with zero record of how many chunks lack vectors.
 *
 * Regression: indexChunks must LOG the unembedded count (and never bury the
 * failure in an empty catch), so a wholesale-failed embed is observable rather
 * than a silent success.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { indexChunks } from "./index-ingest.js";
import { DEFAULT_MEMORY_CONFIG, type EmbeddingProvider, type Chunk } from "./types.js";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-ingest-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(tempDir);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("indexChunks — embedding failure is not swallowed", () => {
  it("logs the unembedded count when the provider is down (would-be silent vector-invisible import)", async () => {
    const db = memory["db"] as InstanceType<typeof import("better-sqlite3")>;
    // Simulates Ollama down: embedBatch throws, so embedChunksWithRetry exhausts
    // its (single) retry and RESOLVES with no vectors — no exception reaches
    // indexChunks. Pre-fix this path logged nothing at the ingest seam.
    const dead: EmbeddingProvider = {
      name: "ollama", model: "mxbai", dimensions: 4,
      embed: async () => { throw new Error("ECONNREFUSED"); },
      embedBatch: async () => { throw new Error("ECONNREFUSED"); },
    };
    const cfg = { ...DEFAULT_MEMORY_CONFIG, retryMaxAttempts: 1, retryBaseDelayMs: 1 };
    const virtualPath = "import/chatgpt/convo-1";
    const chunks: Chunk[] = [
      { path: virtualPath, source: "import", startLine: 1, endLine: 1, text: "alpha turn", hash: "h-alpha" },
      { path: virtualPath, source: "import", startLine: 2, endLine: 2, text: "beta turn", hash: "h-beta" },
    ];

    // logger.warn / logger.error route through console.error (stderr mirror).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await indexChunks(
      db, dead, cfg, memory["hasFts"] as boolean, memory["hasVec"] as boolean,
      () => {}, chunks, virtualPath, "import",
    );
    const logged = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    errSpy.mockRestore();

    // Chunks are still inserted (keyword search survives) but WITHOUT vectors...
    const nullCount = (db.prepare(
      "SELECT COUNT(*) AS n FROM chunks WHERE path = ? AND embedding IS NULL",
    ).get(virtualPath) as { n: number }).n;
    expect(nullCount).toBe(2);

    // ...and the unembedded count MUST be logged at the ingest seam — pre-fix
    // this was an empty catch / silent resolve, so nothing named the gap here.
    expect(logged).toMatch(/2\/2 chunk\(s\)/);
    expect(logged.toLowerCase()).toContain("without embeddings");
  });
});
