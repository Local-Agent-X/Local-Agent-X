// A side call on the model a foreground op is driving waits for the op; the
// op's own calls pass through; a call on another model never waits; the cap
// lets a stuck op release the caller.
import { describe, it, expect, beforeEach } from "vitest";
import {
  runAsForegroundOp, awaitForegroundModelIdle, foregroundOpsOn, _resetForegroundLeasesForTests,
} from "./foreground-model-lease.js";

const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const op = (id: string, lane: string, model: string | null = "qwen3.6:27b") => ({ id, lane, model });

beforeEach(() => _resetForegroundLeasesForTests());

describe("foreground model lease", () => {
  it("an interactive op leases its model for exactly as long as it is driven", async () => {
    let inside = 0;
    const p = runAsForegroundOp(op("op1", "interactive"), async () => { inside = foregroundOpsOn("qwen3.6:27b"); await later(50, 0); });
    expect(foregroundOpsOn("qwen3.6:27b")).toBe(1);
    await p;
    expect(inside).toBe(1);
    expect(foregroundOpsOn("qwen3.6:27b")).toBe(0);
  });

  it("a background op, or an op with no model, leases nothing", async () => {
    await runAsForegroundOp(op("bg", "background"), async () => { expect(foregroundOpsOn("qwen3.6:27b")).toBe(0); });
    await runAsForegroundOp(op("nm", "interactive", null), async () => { expect(foregroundOpsOn("qwen3.6:27b")).toBe(0); });
  });

  it("a side call waits until the op releases, and reports that it waited", async () => {
    const opDone = runAsForegroundOp(op("op1", "interactive"), () => later(400, 0));
    const started = Date.now();
    const idle = await awaitForegroundModelIdle("qwen3.6:27b");
    expect(idle).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    await opDone;
  });

  it("a side call on a different model never waits", async () => {
    const opDone = runAsForegroundOp(op("op1", "interactive"), () => later(300, 0));
    const started = Date.now();
    expect(await awaitForegroundModelIdle("qwen3:8b")).toBe(true);
    expect(Date.now() - started).toBeLessThan(100);
    await opDone;
  });

  it("the op's OWN call passes straight through — the compaction summarizer must not wait on its own op", async () => {
    await runAsForegroundOp(op("op1", "interactive"), async () => {
      const started = Date.now();
      expect(await awaitForegroundModelIdle("qwen3.6:27b")).toBe(true);
      expect(Date.now() - started).toBeLessThan(100);
      // …even from a nested await chain inside the op.
      await later(10, 0);
      expect(await awaitForegroundModelIdle("qwen3.6:27b")).toBe(true);
    });
  });

  it("the cap releases a caller stuck behind a hung op, and says so", async () => {
    const opDone = runAsForegroundOp(op("op1", "interactive"), () => later(2_000, 0));
    const started = Date.now();
    expect(await awaitForegroundModelIdle("qwen3.6:27b", 300)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(1_500);
    await opDone;
  });

  it("the lease is released when the op throws", async () => {
    await expect(runAsForegroundOp(op("op1", "interactive"), async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(foregroundOpsOn("qwen3.6:27b")).toBe(0);
  });
});
