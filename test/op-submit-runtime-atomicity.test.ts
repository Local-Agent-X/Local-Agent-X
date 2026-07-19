import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../src/ops/types.js";

const fixture = vi.hoisted(() => ({
  entry: vi.fn(),
  track: vi.fn(),
  configure: vi.fn(async () => { throw new Error("runtime admission failed"); }),
  op: {
    id: "op_atomic_runtime_failure",
    type: "freeform",
    task: "must remain invisible",
    lane: "interactive",
    contextPack: { routing: {} },
    retryPolicy: { maxRecoveryAttempts: 0, backoffMs: [] },
    ownerId: "local-user",
    visibility: "private",
    status: "pending",
    createdAt: "2026-07-18T00:00:00.000Z",
    attemptCount: 0,
  },
}));

vi.mock("../src/canonical-loop/index.js", () => ({
  canonicalLoopEntry: fixture.entry,
  awaitCanonicalOp: vi.fn(),
  awaitOpRunning: vi.fn(),
}));
vi.mock("../src/ops/session-bridge.js", () => ({
  trackOpForSession: fixture.track,
  listOpsForSession: () => [],
}));
vi.mock("../src/ops/tools/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ops/tools/shared.js")>();
  return {
    ...actual,
    buildOpFromArgs: vi.fn(async () => ({ ...fixture.op } as Op)),
    configureDelegatedRuntime: fixture.configure,
  };
});

const { opSubmitTool } = await import("../src/ops/tools/op-submit.js");
const { opSubmitAsyncTool } = await import("../src/ops/tools/op-submit-async.js");
const { opSubmitBatchTool } = await import("../src/ops/tools/op-submit-batch.js");
const { RECENT_SUBMITS } = await import("../src/ops/tools/shared.js");

beforeEach(() => {
  fixture.entry.mockClear();
  fixture.track.mockClear();
  fixture.configure.mockClear();
  RECENT_SUBMITS.clear();
});

describe("delegated runtime admission is submission-atomic", () => {
  it.each([
    ["sync", () => opSubmitTool.execute({ task: "sync", _sessionId: "atomic-session" })],
    ["async", () => opSubmitAsyncTool.execute({ task: "async", _sessionId: "atomic-session" })],
  ])("does not enqueue, track, or deduplicate a failed %s submission", async (_label, submit) => {
    await expect(submit()).rejects.toThrow("runtime admission failed");
    expect(fixture.entry).not.toHaveBeenCalled();
    expect(fixture.track).not.toHaveBeenCalled();
    expect(RECENT_SUBMITS.has("atomic-session")).toBe(false);
  });

  it("keeps every failed batch item invisible to the scheduler and session bridge", async () => {
    const result = await opSubmitBatchTool.execute({
      _sessionId: "atomic-session",
      tasks: [{ task: "one" }, { task: "two" }],
    });
    const batch = (result.metadata as { batch: { results: Array<{ opId: string | null; status: string }> } }).batch;
    expect(batch.results).toEqual([
      expect.objectContaining({ opId: null, status: "failed" }),
      expect.objectContaining({ opId: null, status: "failed" }),
    ]);
    expect(fixture.entry).not.toHaveBeenCalled();
    expect(fixture.track).not.toHaveBeenCalled();
    expect(RECENT_SUBMITS.size).toBe(0);
  });
});
