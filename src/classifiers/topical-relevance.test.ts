import { describe, it, expect, vi } from "vitest";

import { batchedTopicalRelevance } from "./topical-relevance.js";

const SIGNALS = ["kraken bot fees", "open-memory chunks", "user prefers light mode"];

/** Run the gate with the LLM returning `raw` as JSON, exercising the real schema. */
async function gateRaw(raw: unknown) {
  return batchedTopicalRelevance("audit the kraken bot", SIGNALS, {
    _llm: async () => JSON.stringify(raw),
  });
}

describe("batchedTopicalRelevance schema — index mapping + range check", () => {
  it("maps 1-based reply indices to a 0-based set", async () => {
    const result = await gateRaw({ relevant_indices: [1, 3] });
    expect(result?.relevantIndices).toEqual(new Set([0, 2]));
  });

  it("coerces numeric strings and drops out-of-range / non-numeric entries", async () => {
    const result = await gateRaw({ relevant_indices: ["2", 0, 4, "nope", null] });
    expect(result?.relevantIndices).toEqual(new Set([1]));
  });

  it("accepts an empty relevance verdict", async () => {
    const result = await gateRaw({ relevant_indices: [] });
    expect(result?.relevantIndices).toEqual(new Set());
  });

  it("rejects a missing / non-array relevant_indices → null → regex fallback", async () => {
    expect(await gateRaw({ relevant_indices: "1,3" })).toBeNull();
    expect(await gateRaw({})).toBeNull();
    expect(await gateRaw(null)).toBeNull();
  });

  it("returns null on non-JSON garbage after the single retry", async () => {
    const llm = vi.fn(async () => "signals 1 and 3 look relevant");
    expect(await batchedTopicalRelevance("audit the kraken bot", SIGNALS, { _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("returns null without retrying when the LLM is unavailable", async () => {
    const llm = vi.fn(async () => null);
    expect(await batchedTopicalRelevance("audit the kraken bot", SIGNALS, { _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("short-circuits an empty signal list without calling the LLM", async () => {
    const llm = vi.fn(async () => `{"relevant_indices":[]}`);
    const result = await batchedTopicalRelevance("anything", [], { _llm: llm });
    expect(result?.relevantIndices).toEqual(new Set());
    expect(llm).not.toHaveBeenCalled();
  });
});
