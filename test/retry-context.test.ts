import { describe, it, expect } from "vitest";
import { attachRetryContext, createRetryContext, detachRetryContext, getRetryContext } from "../src/retry-context.js";
import { withRetry } from "../src/auto-retry.js";

describe("RetryContext", () => {
  // A shared attempt budget once gated withRetry and killed slow-start tools
  // like `browser` before their first real attempt, when a turn had spent it
  // on PDF lookups. The context is a correlationId only; these pin that a
  // context never caps a call's own retries.
  it("never caps a call's own retries, however many calls share it", async () => {
    const ctx = createRetryContext();
    let calls = 0;
    const failing = async () => { calls++; throw new Error("boom"); };

    await expect(withRetry(failing, { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 2, ctx })).rejects.toThrow();
    expect(calls).toBe(6); // 1 initial + 5 retries

    await expect(withRetry(failing, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, ctx })).rejects.toThrow();
    expect(calls).toBe(9); // 6 + (1 initial + 2 retries)
  });

  it("succeeds after a transient failure", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "ok";
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2, ctx: createRetryContext() });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("works without a ctx", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error("x"); }, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 }),
    ).rejects.toThrow();
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("is attached per session with a fresh correlationId each turn", () => {
    const a = createRetryContext();
    const b = createRetryContext();
    expect(a.correlationId).not.toBe(b.correlationId);
    attachRetryContext("s1", a);
    expect(getRetryContext("s1")).toBe(a);
    expect(getRetryContext(undefined)).toBeUndefined();
    detachRetryContext("s1");
    expect(getRetryContext("s1")).toBeUndefined();
  });
});
