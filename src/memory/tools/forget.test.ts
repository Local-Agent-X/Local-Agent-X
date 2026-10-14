// memory_forget's query mode deletes the chunks of the paths that matched —
// exactly those paths. It used to delete by substring, so forgetting a hit at
// `notes/a.md` also wiped `notes/a.md.bak` and `x/notes/a.md`, which the query
// never matched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../../memory/index.js";
import type { Chunk } from "../types.js";
import { createForgetTool } from "./forget.js";

let tempDir: string;
let memory: MemoryIndex;

const chunkAt = (path: string, text: string): Chunk =>
  ({ path, source: "memory-file", startLine: 1, endLine: 1, text, hash: `h-${path}` });

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-forget-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(tempDir);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const countAt = (path: string): number =>
  (memory["db"].prepare("SELECT COUNT(*) AS n FROM chunks WHERE path = ?").get(path) as { n: number }).n;

describe("forgetChunksAtPath", () => {
  it("removes one path and leaves the paths that merely contain it", async () => {
    await memory.indexChunks([chunkAt("notes/a.md", "zebra facts")], "notes/a.md", "memory-file");
    await memory.indexChunks([chunkAt("notes/a.md.bak", "backup copy")], "notes/a.md.bak", "memory-file");
    await memory.indexChunks([chunkAt("x/notes/a.md", "other project")], "x/notes/a.md", "memory-file");

    expect(memory.forgetChunksAtPath("notes/a.md")).toBe(1);

    expect(countAt("notes/a.md")).toBe(0);
    expect(countAt("notes/a.md.bak")).toBe(1);
    expect(countAt("x/notes/a.md")).toBe(1);
  });
});

describe("memory_forget query mode", () => {
  it("forgets each hit's exact path once, never by substring", async () => {
    const hit = (path: string) => ({ path, source: "memory-file", snippet: "zebra", score: 0.9 });
    const stub = {
      memoryDir: join(tempDir, "memory"),
      search: vi.fn(async () => [hit("notes/a.md"), hit("notes/a.md")]),
      forgetChunksAtPath: vi.fn(() => 1),
      forgetChunks: vi.fn(() => 99),
    };
    const tool = createForgetTool(stub as unknown as MemoryIndex);

    const res = await tool.execute({ query: "zebra", confirm: true });

    expect(stub.forgetChunksAtPath.mock.calls).toEqual([["notes/a.md"]]);
    expect(stub.forgetChunks).not.toHaveBeenCalled();
    expect(res.content).toContain("Deleted 1 chunk(s)");
  });
});
