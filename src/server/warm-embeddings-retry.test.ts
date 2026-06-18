// Regression: an unlucky boot (Ollama unreachable while the box is saturated)
// left embeddings stuck on keyword search forever — initOrRefreshEmbeddingProvider
// was one-shot, nothing retried. warmEmbeddingsWithRetry re-runs it until it
// reports non-degraded. These pin: stop on first success, retry-then-succeed,
// and bounded give-up. sleep is injected so no real timers run.
import { describe, it, expect, vi } from "vitest";
import { warmEmbeddingsWithRetry } from "./bootstrap-services.js";

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

describe("warmEmbeddingsWithRetry", () => {
  it("returns after one call when init is already healthy (no sleeps)", async () => {
    const initOnce = vi.fn().mockResolvedValue({ degraded: false });
    const sleep = vi.fn(noSleep);
    const r = await warmEmbeddingsWithRetry(initOnce, { delaysMs: [1, 2, 3], sleep });
    expect(r).toEqual({ attempts: 1, degraded: false });
    expect(initOnce).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on degraded and stops the moment it goes healthy", async () => {
    const initOnce = vi.fn()
      .mockResolvedValueOnce({ degraded: true })
      .mockResolvedValueOnce({ degraded: true })
      .mockResolvedValueOnce({ degraded: false });
    const sleep = vi.fn(noSleep);
    const r = await warmEmbeddingsWithRetry(initOnce, { delaysMs: [10, 20, 30, 40], sleep });
    expect(r).toEqual({ attempts: 3, degraded: false });
    expect(initOnce).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]); // backoff used in order
  });

  it("gives up after delaysMs.length retries and reports still-degraded", async () => {
    const initOnce = vi.fn().mockResolvedValue({ degraded: true });
    const onGiveUp = vi.fn();
    const r = await warmEmbeddingsWithRetry(initOnce, { delaysMs: [1, 1, 1], sleep: noSleep, onGiveUp });
    expect(r).toEqual({ attempts: 4, degraded: true }); // 1 initial + 3 retries
    expect(initOnce).toHaveBeenCalledTimes(4);
    expect(onGiveUp).toHaveBeenCalledWith(4);
  });
});
