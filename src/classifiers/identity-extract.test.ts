import { describe, it, expect, vi } from "vitest";

import { extractIdentityFactsWithLLM } from "./identity-extract.js";

/** Run the extractor with the LLM returning `raw` as JSON, exercising the real schema. */
async function extractRaw(userMessage: string, raw: unknown) {
  return extractIdentityFactsWithLLM(userMessage, { _llm: async () => JSON.stringify(raw) });
}

describe("extractIdentityFactsWithLLM schema — evidence-verified facts", () => {
  it("accepts a fact backed by a verbatim evidence span", async () => {
    const result = await extractRaw("hey, I'm Alex by the way", {
      user_name: "Alex",
      evidence_spans: { user_name: "I'm Alex" },
    });
    expect(result?.user_name).toBe("Alex");
  });

  it("rejects a fact whose evidence span is NOT a verbatim substring of the message", async () => {
    const result = await extractRaw("just checking in on the build", {
      user_name: "Justin",
      evidence_spans: { user_name: "my name is Justin" },
    });
    // Field nulled; nothing survives → empty-shape marker (ran, found nothing).
    expect(result).toEqual({ user_name: null });
  });

  it("rejects a fact with no evidence span at all", async () => {
    const result = await extractRaw("I'm Alex", { user_name: "Alex", evidence_spans: {} });
    expect(result).toEqual({ user_name: null });
  });

  it("enforces per-field length caps (fail-soft null, not rejection)", async () => {
    const long = "x".repeat(41);
    const message = `call me ${long} and I live in Austin`;
    const result = await extractRaw(message, {
      user_name: long,
      user_location: "Austin",
      evidence_spans: { user_name: long, user_location: "I live in Austin" },
    });
    expect(result?.user_name ?? null).toBeNull();
    expect(result?.user_location).toBe("Austin");
  });

  it("filters relationships per-index against evidence spans", async () => {
    const message = "my wife is Sam";
    const result = await extractRaw(message, {
      relationships: [
        { relation: "wife", name: "Sam" },
        { relation: "brother", name: "Chris" },
      ],
      evidence_spans: { relationships: ["my wife is Sam", "my brother Chris"] },
    });
    // Second span isn't in the message → second entry dropped.
    expect(result?.relationships).toEqual([{ relation: "wife", name: "Sam" }]);
  });

  it("filters ongoing_state entries whose spans aren't verbatim", async () => {
    const message = "I'm learning Spanish these days";
    const result = await extractRaw(message, {
      ongoing_state: ["User is learning Spanish", "User is on keto"],
      evidence_spans: { ongoing_state: ["I'm learning Spanish", "I'm on keto"] },
    });
    expect(result?.ongoing_state).toEqual(["User is learning Spanish"]);
  });

  it("returns null on non-JSON garbage after the single retry — no memory write", async () => {
    const llm = vi.fn(async () => "the user's name is Alex");
    expect(await extractIdentityFactsWithLLM("I'm Alex", { _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("returns null on a non-object root (rejected, retried once)", async () => {
    const llm = vi.fn(async () => `"Alex"`);
    expect(await extractIdentityFactsWithLLM("I'm Alex", { _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("returns null without retrying when the LLM is unavailable", async () => {
    const llm = vi.fn(async () => null);
    expect(await extractIdentityFactsWithLLM("I'm Alex", { _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("pre-skips empty and over-long messages without calling the LLM", async () => {
    const llm = vi.fn(async () => `{"user_name":null}`);
    expect(await extractIdentityFactsWithLLM("", { _llm: llm })).toBeNull();
    expect(await extractIdentityFactsWithLLM("a".repeat(1201), { _llm: llm })).toBeNull();
    expect(llm).not.toHaveBeenCalled();
  });
});
