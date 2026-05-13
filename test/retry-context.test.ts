import { describe, it, expect } from "vitest";
import { createRetryContext } from "../src/retry-context.js";
import { withRetry } from "../src/auto-retry.js";

describe("RetryContext shared budget", () => {
  it("caps total attempts across multiple withRetry calls in the same context", async () => {
    const ctx = createRetryContext({ maxAttempts: 3, deadlineMs: Date.now() + 60_000 });
    let calls = 0;
    const failing = async () => { calls++; throw new Error("boom"); };

    // First withRetry: would normally do 1 + maxRetries(5) = 6 attempts, but
    // the shared budget caps it at 3.
    await expect(
      withRetry(failing, { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 2, ctx }),
    ).rejects.toThrow();

    expect(calls).toBe(3);
    expect(ctx.budget.attemptsUsed).toBe(3);

    // Second withRetry in the same context: budget already exhausted →
    // bails before invoking fn even once.
    await expect(
      withRetry(failing, { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 2, ctx }),
    ).rejects.toThrow();

    expect(calls).toBe(3); // unchanged — second call never ran fn
  });

  it("respects the deadline even when attempts remain", async () => {
    const ctx = createRetryContext({ maxAttempts: 100, deadlineMs: Date.now() - 1 });
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error("x"); }, {
        maxRetries: 5, baseDelayMs: 1, maxDelayMs: 2, ctx,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("invokes onAttempt with layer label and attempt number", async () => {
    const observed: Array<{ layer: string; attempt: number }> = [];
    const ctx = createRetryContext({
      maxAttempts: 5,
      onAttempt: (layer, attempt) => observed.push({ layer, attempt }),
    });

    await expect(
      withRetry(async () => { throw new Error("nope"); }, {
        maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, ctx, layer: "L1-tool",
      }),
    ).rejects.toThrow();

    expect(observed.length).toBe(3); // initial + 2 retries
    expect(observed.every(o => o.layer === "L1-tool")).toBe(true);
    expect(observed.map(o => o.attempt)).toEqual([1, 2, 3]);
  });

  it("succeeds and consumes only the attempts it needed", async () => {
    const ctx = createRetryContext({ maxAttempts: 10 });
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "ok";
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2, ctx });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(ctx.budget.attemptsUsed).toBe(2);
  });

  it("works without a ctx (unchanged legacy behavior)", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error("x"); }, {
        maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(3); // 1 initial + 2 retries
  });
});
