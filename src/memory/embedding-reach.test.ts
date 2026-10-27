// A project document's text goes only to an embedder on this machine, on
// every path that embeds (first index and the background re-embed), and the
// memory sync never sweeps project documents away as missing files.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { countChunksMissingEmbedding, reembedMissingChunks } from "./index-embedding.js";
import { DEFAULT_MEMORY_CONFIG, type Chunk, type EmbeddingProvider } from "./types.js";

function recordingProvider(onBox: boolean | undefined): EmbeddingProvider & { seen: string[] } {
  const seen: string[] = [];
  return {
    name: onBox ? "local" : "cloud", model: "m", dimensions: 4, onBox, seen,
    embed: async (t: string) => { seen.push(t); return [0.1, 0.2, 0.3, 0.4]; },
    embedBatch: async (texts: string[]) => { seen.push(...texts); return texts.map(() => [0.1, 0.2, 0.3, 0.4]); },
  };
}

const chunk = (text: string): Chunk => ({ path: "", source: "", startLine: 1, endLine: 1, text, hash: `h-${text}` });

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-embed-reach-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(tempDir);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const embeddedCount = (path: string) =>
  (memory["db"].prepare("SELECT COUNT(*) AS n FROM chunks WHERE path = ? AND embedding IS NOT NULL").get(path) as { n: number }).n;

describe("which embedder sees a project document", () => {
  it("a cloud or unmarked provider never receives its text; the document is still keyword-searchable", async () => {
    for (const onBox of [false, undefined]) {
      const cloud = recordingProvider(onBox);
      await memory.setEmbeddingProvider(cloud);
      cloud.seen.length = 0;
      const path = `project/proj-a/pricing-${String(onBox)}.md`;
      await memory.indexChunksIdempotent([chunk(`quarterly pricing review ${String(onBox)}`)], path, "project-doc");
      await memory.indexChunks([chunk(`renewal terms ${String(onBox)}`)], `${path}.2`, "project-doc");
      expect(cloud.seen.join("\n")).not.toMatch(/pricing review|renewal terms/);
      expect(embeddedCount(path)).toBe(0);
      const hits = await memory.search("quarterly pricing review", { projectId: "proj-a" });
      expect(hits.some((h) => h.path === path)).toBe(true);
    }
  });

  it("an on-box provider embeds it", async () => {
    const local = recordingProvider(true);
    await memory.setEmbeddingProvider(local);
    await memory.indexChunksIdempotent([chunk("quarterly pricing review")], "project/proj-a/pricing.md", "project-doc");
    expect(local.seen).toContain("quarterly pricing review");
    expect(embeddedCount("project/proj-a/pricing.md")).toBe(1);
  });

  it("the background re-embed after a switch to a cloud provider skips it and does not count it missing", async () => {
    await memory.setEmbeddingProvider(recordingProvider(true));
    await memory.indexChunksIdempotent([chunk("quarterly pricing review")], "project/proj-a/pricing.md", "project-doc");
    memory["db"].prepare("UPDATE chunks SET embedding = NULL").run();
    const cloud = recordingProvider(false);
    expect(countChunksMissingEmbedding(memory["db"], cloud)).toBe(0);
    await reembedMissingChunks(memory["db"], cloud, DEFAULT_MEMORY_CONFIG, false);
    expect(cloud.seen).toEqual([]);
    expect(countChunksMissingEmbedding(memory["db"], recordingProvider(true))).toBe(1);
  });
});

describe("the memory sync", () => {
  it("keeps project documents, which live outside the memory dir", async () => {
    await memory.indexChunksIdempotent([chunk("quarterly pricing review")], "project/proj-a/pricing.md", "project-doc");
    memory["dirty"] = true;
    await memory.sync();
    const n = (memory["db"].prepare("SELECT COUNT(*) AS n FROM chunks WHERE path = 'project/proj-a/pricing.md'").get() as { n: number }).n;
    expect(n).toBe(1);
  });
});
