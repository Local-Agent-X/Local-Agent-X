import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { rerankWithLLM } from "./reranker.js";
import type { MemorySearchResult } from "./index.js";

// Regression lock: the reranker's Ollama call must derive its URL from
// config.ollamaUrl, not a hardcoded localhost:11434. It shipped hardcoded,
// so a user pointing LAX_OLLAMA_URL at a non-default host got working chat
// but silently broken reranking (fetch to a dead port returns [], and the
// reranker degrades quietly by design).
vi.mock("../config.js", () => ({
  getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:9999/" }),
}));

function result(snippet: string): MemorySearchResult {
  return { snippet, score: 0.5 } as MemorySearchResult;
}

describe("rerankWithLLM ollama URL comes from config (fetch stubbed — no network)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ response: "[8, 2]" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls config.ollamaUrl (trailing slash stripped), never hardcoded localhost:11434", async () => {
    const out = await rerankWithLLM("q", [result("a"), result("b")], { provider: "ollama" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:9999/api/generate");
    // Scores applied → reranked ordering preserved with blended scores.
    expect(out).toHaveLength(2);
  });
});
