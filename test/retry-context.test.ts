import { describe, it, expect } from "vitest";
import { createRetryContext } from "../src/retry-context.js";
import { withRetry } from "../src/auto-retry.js";

describe("RetryContext shared budget", () => {
  // The shared-budget GATING (throw on maxAttempts exhausted, throw on
  // deadline past) was removed after a regression where slow-start tools
  // like `browser` got killed before their first real attempt — a turn
  // that spent its 90s budget on PDF lookups had no budget left when
  // browser finally ran. Each withRetry call's own `maxRetries` is the
  // correct per-call cap; the shared context is now correlationId +
  // telemetry only. These tests pin the new contract — if someone
  // re-introduces gating without reading the history, the tests force
  // a conversation.
  it("counts attempts in budget.attemptsUsed for telemetry without capping", async () => {
    const ctx = createRetryContext({ maxAttempts: 3, deadlineMs: Date.now() + 60_000 });
    let calls = 0;
    const failing = async () => { calls++; throw new Error("boom"); };

    // First withRetry: local maxRetries(5) is the cap, NOT ctx.maxAttempts(3).
    // Runs 1 initial + 5 retries = 6 attempts.
    await expect(
      withRetry(failing, { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 2, ctx }),
    ).rejects.toThrow();

    expect(calls).toBe(6);
    expect(ctx.budget.attemptsUsed).toBe(6); // telemetry: counted past maxAttempts

    // Second withRetry in the same context: budget keeps incrementing but
    // doesn't gate. The second call still runs its own retry loop.
    await expect(
      withRetry(failing, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, ctx }),
    ).rejects.toThrow();

    expect(calls).toBe(9); // 6 + (1 initial + 2 retries)
    expect(ctx.budget.attemptsUsed).toBe(9);
  });

  it("ignores a deadline that's already passed (no early-exit gating)", async () => {
    const ctx = createRetryContext({ maxAttempts: 100, deadlineMs: Date.now() - 1 });
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error("x"); }, {
        maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, ctx,
      }),
    ).rejects.toThrow();
    // Local maxRetries still applies: 1 initial + 2 retries = 3.
    // Deadline is ignored — execution proceeds even though it's past.
    expect(calls).toBe(3);
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
