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
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(memory.recallByKind("opinion").map((fact) => fact.content)).toContain("User prefers Vim");
  });

  it("does not flag a realistic repetitive-ish bullet list (calibration fixture)", async () => {
    // 20 short facts sharing the "- W(c=0.9) @user:" prefix — the legitimate
    // shape of this lane's output. Measured 2026-07-13: gzip ratio ~0.48
    // (floor 0.10), duplicate-substantial-line ratio 0.000 (threshold 0.40).
    const bulletFixture = Array.from({ length: 20 }, (_, i) =>
      `- W(c=0.9) @user: tracked distinct durable fact number ${i + 1} about project alpha`
    ).join("\n");
    seedChunk(memory, "session-live/session-cal", "calibration transcript");
    // dispatch also serves retainSmart's resolver; route by prompt so the
    // resolver ADDs every candidate instead of parsing bullet text as an op.
    dispatch.mockImplementation(async (args: { prompt: string }) =>
      args.prompt.includes("memory-consolidation assistant")
        ? bulletFixture
        : "OP=ADD TARGET=- REASON=new info"
    );

    const result = await runExtraction(memory, { lookbackHours: 1, maxSessions: 1 });

    expect(result.errors).toEqual([]);
    // Accepted on the first attempt — no rejection-feedback prompt ever built.
    // (dispatch is also called by retainSmart's resolver, so raw call counts
    // can't distinguish extraction retries; the feedback marker can.)
    const feedbackCalls = dispatch.mock.calls.filter((call) =>
      (call[0] as { prompt: string }).prompt.includes("previous attempt was rejected")
    );
    expect(feedbackCalls).toEqual([]);
    expect(result.factsExtracted).toBe(20);
  });

  it("retries a looping output with feedback, then falls into the null path with no retention", async () => {
    seedChunk(memory, "session-live/session-loop", "looping transcript");
    const loop = Array.from({ length: 20 }, () =>
      "- W @user prefers bash over Python for scripting always"
    ).join("\n");
    dispatch.mockResolvedValue(loop);

    const result = await runExtraction(memory, { lookbackHours: 1, maxSessions: 1 });

    expect(dispatch).toHaveBeenCalledTimes(2);
    const retryPrompt = (dispatch.mock.calls[1][0] as { prompt: string }).prompt;
    expect(retryPrompt).toContain("rejected");
    expect(retryPrompt).toContain("loop");
    // Degenerate after retries behaves exactly like "dispatch returned null":
    // logged as an error, zero facts written, no throw.
    expect(result.errors).toEqual([
      "session-live/session-loop: LLM returned null (provider unreachable or returned empty)",
    ]);
    expect(result.factsExtracted).toBe(0);
    expect(memory.recallByKind("world")).toEqual([]);
  });

  it("recovers when the retry produces a good output", async () => {
    seedChunk(memory, "session-live/session-recover", "recovery transcript");
    const loop = Array.from({ length: 20 }, () =>
      "- W @user prefers bash over Python for scripting always"
    ).join("\n");
    dispatch
      .mockResolvedValueOnce(loop)
      .mockResolvedValueOnce("- O(c=0.9) @user: User prefers Kraken over Coinbase");

    const result = await runExtraction(memory, { lookbackHours: 1, maxSessions: 1 });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.errors).toEqual([]);
    expect(result.factsExtracted).toBe(1);
    expect(memory.recallByKind("opinion").map((fact) => fact.content))
      .toContain("User prefers Kraken over Coinbase");
  });

  it("does not retry a transport-level null and takes the existing null path", async () => {
    seedChunk(memory, "session-live/session-null", "unreachable transcript");
    dispatch.mockResolvedValue(null);

    const result = await runExtraction(memory, { lookbackHours: 1, maxSessions: 1 });

    expect(dispatch).toHaveBeenCalledTimes(1); // transport failure — no retry burn
    expect(result.errors).toEqual([
      "session-live/session-null: LLM returned null (provider unreachable or returned empty)",
    ]);
    expect(result.factsExtracted).toBe(0);
  });
});

function seedChunk(memory: MemoryIndex, path: string, text: string): void {
  memory["db"].prepare(`
    INSERT INTO chunks
      (path, source, start_line, end_line, text, hash, content_hash, embedding, updated_at, metadata, session_id)
    VALUES (?, 'session', 1, 1, ?, 'h1', 'h1', NULL, ?, '{}', 'seed')
  `).run(path, text, Date.now());
}
