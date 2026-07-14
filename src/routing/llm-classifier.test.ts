import { describe, it, expect, vi } from "vitest";

import { classifyRouteWithLLM } from "./llm-classifier.js";

/** Run the route classifier with the LLM returning `raw` as JSON, exercising the real schema. */
async function routeRaw(raw: unknown) {
  return classifyRouteWithLLM("build me a kanban app", undefined, async () => JSON.stringify(raw));
}

describe("classifyRouteWithLLM schema — INLINE/DELEGATE verdict", () => {
  it("parses an INLINE verdict", async () => {
    const result = await routeRaw({ decision: "INLINE", reason: "quick answer" });
    expect(result).toMatchObject({ inline: true, reason: "quick answer" });
    expect(result?.raw).toContain("INLINE");
  });

  it("normalizes decision casing/whitespace and parses DELEGATE", async () => {
    const result = await routeRaw({ decision: " delegate ", reason: "worker-class build" });
    expect(result?.inline).toBe(false);
  });

  it("coerces a missing reason instead of rejecting", async () => {
    const result = await routeRaw({ decision: "INLINE" });
    expect(result?.reason).toBe("(no reason given)");
  });

  it("rejects an unknown decision → null → regex fallback", async () => {
    expect(await routeRaw({ decision: "MAYBE", reason: "?" })).toBeNull();
    expect(await routeRaw({ reason: "no decision" })).toBeNull();
    expect(await routeRaw(null)).toBeNull();
  });

  it("returns null on non-JSON garbage after the single retry", async () => {
    const llm = vi.fn(async () => "I'd say delegate this one");
    expect(await classifyRouteWithLLM("build me a kanban app", undefined, llm)).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("returns null without retrying when the LLM is unavailable", async () => {
    const llm = vi.fn(async () => null);
    expect(await classifyRouteWithLLM("build me a kanban app", undefined, llm)).toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("skips the LLM entirely for over-long messages (task-class shortcut)", async () => {
    const llm = vi.fn(async () => `{"decision":"INLINE","reason":"x"}`);
    const result = await classifyRouteWithLLM("x".repeat(4001), undefined, llm);
    expect(result?.inline).toBe(false);
    expect(result?.raw).toBe("(skipped)");
    expect(llm).not.toHaveBeenCalled();
  });
});
