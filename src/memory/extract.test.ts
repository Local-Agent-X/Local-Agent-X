import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../llm-dispatch.js", () => ({ dispatch }));

import { MemoryIndex } from "./index.js";
import { runExtraction } from "./extract.js";

describe("memory consolidation persistence", () => {
  let dir: string;
  let memory: MemoryIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-memory-extract-"));
    memory = new MemoryIndex(dir, { minScore: -1 });
    dispatch.mockReset();
  });

  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists and counts facts extracted from an indexed session", async () => {
    const now = Date.now();
    memory["db"].prepare(`
      INSERT INTO chunks
        (path, source, start_line, end_line, text, hash, content_hash, embedding, updated_at, metadata, session_id)
      VALUES (?, 'session', 1, 1, ?, 'h1', 'h1', NULL, ?, '{}', ?)
    `).run("session-live/session-1", "User explicitly said their preferred editor is Vim.", now, "session-1");
    dispatch.mockResolvedValue("- O(c=0.9) @user: User prefers Vim");

    const result = await runExtraction(memory, { lookbackHours: 1, maxSessions: 1 });

    expect(result.errors).toEqual([]);
    expect(result.factsExtracted).toBe(1);
    expect(memory.recallByKind("opinion").map((fact) => fact.content)).toContain("User prefers Vim");
  });
});
