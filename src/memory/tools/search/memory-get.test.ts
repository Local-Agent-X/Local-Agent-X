// memory_recall / memory_search hand out `import/<source>/<id>` paths for
// imported conversations ("full conversation via memory_get(...)"). Those
// live only in the chunk store, so memory_get used to answer "not found" for
// every one of them. It now reads them from the index.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../../../memory/index.js";
import type { Chunk } from "../../types.js";
import { memoryGetTool } from "./memory-get.js";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-memory-get-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(tempDir);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("memory_get on an imported conversation path", () => {
  it("returns the conversation's chunks in order", async () => {
    const path = "import/chatgpt/convo-1";
    const chunks: Chunk[] = [
      { path, source: "import", startLine: 3, endLine: 4, text: "second exchange", hash: "h2", metadata: { source_type: "import", date: "2025-03-01" } },
      { path, source: "import", startLine: 1, endLine: 2, text: "first exchange", hash: "h1", metadata: { source_type: "import", date: "2025-03-01" } },
    ];
    await memory.indexChunks(chunks, path, "import");

    const res = await memoryGetTool(memory).execute({ path });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("first exchange\n\nsecond exchange");
  });

  it("reports an unknown import path as not found and still reads real files", async () => {
    const tool = memoryGetTool(memory);
    expect((await tool.execute({ path: "import/chatgpt/missing" })).content).toContain("Memory file not found");

    writeFileSync(join(tempDir, "memory", "2026-04-16.md"), "## April 16\nShipped it.");
    expect((await tool.execute({ path: "2026-04-16.md" })).content).toContain("Shipped it.");
  });
});
