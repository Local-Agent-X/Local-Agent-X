import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the conductor module so we drive op.status transitions ─────────
// loadOperation is the only conductor symbol awaitOperationStarted reads.
// isExecutorActive lives in the same module as the function under test
// and is called via the module-internal binding — we can NOT mock it
// from out here. Instead, we shape tests around its real behavior:
// activeExecutors map is empty for our synthetic op IDs, so for any
// status === "pending" the function short-circuits to "executor did not
// start". We avoid pending in the running/timeout paths to dodge that.

const loadOperationMock = vi.fn();

vi.mock("./conductor.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadOperation: (...args: unknown[]) => loadOperationMock(...args),
  };
});

import { awaitOperationStarted } from "./executor.js";

beforeEach(() => {
  loadOperationMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("awaitOperationStarted", () => {
  it("fast-paths to running:true when the op is already in status='running' on disk", async () => {
    loadOperationMock.mockReturnValue({ status: "running" });

    const result = await awaitOperationStarted("op-A", { timeoutMs: 200 });

    expect(result).toEqual({ running: true });
    expect(loadOperationMock).toHaveBeenCalled();
  });

  it("returns running:true once the status transitions to 'running' across poll iterations", async () => {
    // Cycle status: "completed" maps to running:true. Use a transitioning
    // shape that does NOT hit pending (pending + !isExecutorActive shorts
    // out to "executor did not start"). "paused" is also a running:true
    // status per the implementation.
    let calls = 0;
    loadOperationMock.mockImplementation(() => {
      calls++;
      if (calls === 1) return { status: "paused" };
      return { status: "running" };
    });

    const result = await awaitOperationStarted("op-B", { timeoutMs: 500 });

    expect(result).toEqual({ running: true });
    expect(loadOperationMock).toHaveBeenCalled();
  });

  it("returns running:false 'executor crashed' when status flips to 'failed'", async () => {
    loadOperationMock.mockReturnValue({ status: "failed" });

    const result = await awaitOperationStarted("op-C", { timeoutMs: 200 });

    expect(result).toEqual({ running: false, reason: "executor crashed during init" });
  });

  it("returns running:false 'not found' when loadOperation returns null", async () => {
    loadOperationMock.mockReturnValue(null);

    const result = await awaitOperationStarted("op-missing", { timeoutMs: 200 });

    expect(result.running).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/not found/);
  });

  it("returns running:false 'cancelled' when status is 'cancelled'", async () => {
    loadOperationMock.mockReturnValue({ status: "cancelled" });

    const result = await awaitOperationStarted("op-D", { timeoutMs: 200 });

    expect(result).toEqual({ running: false, reason: "operation cancelled before start" });
  });

  it("returns running:false 'executor did not start' for pending+inactive (no activeExecutors entry)", async () => {
    // Pending status + activeExecutors map has no entry for our test ID
    // (we never called startExecutor) → isExecutorActive=false → the
    // function shorts out on the first poll iteration with the truthful
    // startup-failure reason.
    loadOperationMock.mockReturnValue({ status: "pending" });

    const result = await awaitOperationStarted("op-E", { timeoutMs: 80 });

    expect(result.running).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/executor did not start/);
  });

  it("returns running:true on status='completed' (terminal-but-finished counts as having run)", async () => {
    loadOperationMock.mockReturnValue({ status: "completed" });

    const result = await awaitOperationStarted("op-G", { timeoutMs: 200 });

    expect(result).toEqual({ running: true });
  });
});
