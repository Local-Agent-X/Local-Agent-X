import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the two module dependencies awaitOpRunning reaches into ───────
// readOp from ../ops/op-store.js   — disk-state probe
// subscribeOpEvents from ./control-api.js  — bus subscription

const readOpMock = vi.fn();
const subscribeOpEventsMock = vi.fn();

vi.mock("../ops/op-store.js", () => ({
  readOp: (...args: unknown[]) => readOpMock(...args),
}));

vi.mock("./control-api.js", () => ({
  subscribeOpEvents: (...args: unknown[]) => subscribeOpEventsMock(...args),
}));

// checkpoint-stop.js is the ONE reader of the worker's stop record; the real
// reader is exercised against a real worker in
// test/worker-honors-iteration-budget.test.ts. Here it is a switch.
const readCheckpointStopMock = vi.fn();
vi.mock("./checkpoint-stop.js", () => ({
  readCheckpointStop: (...args: unknown[]) => readCheckpointStopMock(...args),
  describeCheckpointStop: (opId: string, facts: { completedTurns: number | null; reason: string | null }) =>
    `PARTIAL — child op ${opId} stopped at a checkpoint after ${facts.completedTurns} turns (reason: ${facts.reason})`,
}));

import { awaitOpRunning, awaitCanonicalOp } from "./await-op.js";

type Listener = (event: { type: string; body?: { to?: string } }) => void;

let lastListener: Listener | null = null;
let lastUnsub: ReturnType<typeof vi.fn> | null = null;

beforeEach(() => {
  readOpMock.mockReset();
  subscribeOpEventsMock.mockReset();
  readCheckpointStopMock.mockReset();
  readCheckpointStopMock.mockReturnValue(null);
  lastListener = null;
  lastUnsub = null;

  subscribeOpEventsMock.mockImplementation((_opId: string, listener: Listener) => {
    lastListener = listener;
    lastUnsub = vi.fn();
    return lastUnsub;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("awaitOpRunning", () => {
  it("fast-paths to running:true when the op is already in a post-running state on disk", async () => {
    readOpMock.mockReturnValue({ canonical: { state: "running" } });

    const result = await awaitOpRunning("op-1", 200);

    expect(result).toEqual({ running: true });
    // No subscribe needed — pure synchronous disk-read path.
    expect(subscribeOpEventsMock).not.toHaveBeenCalled();
  });

  it("resolves running:true when a state_changed event flips to running", async () => {
    // First call: op exists but state is "queued" → no fast-path.
    // Second call (race re-check after subscribe): same — still queued.
    readOpMock.mockReturnValue({ canonical: { state: "queued" } });

    const promise = awaitOpRunning("op-2", 200);

    // Subscriber attached. Fire a state_changed → running event.
    expect(subscribeOpEventsMock).toHaveBeenCalledTimes(1);
    expect(lastListener).not.toBeNull();
    lastListener!({ type: "state_changed", body: { to: "running" } });

    const result = await promise;
    expect(result).toEqual({ running: true });
    // Listener should be torn down on settle.
    expect(lastUnsub).toHaveBeenCalled();
  });

  it("resolves running:false with 'op not found' when readOp returns null", async () => {
    readOpMock.mockReturnValue(null);

    const result = await awaitOpRunning("op-missing", 200);

    expect(result).toEqual({ running: false, reason: "op not found" });
    expect(subscribeOpEventsMock).not.toHaveBeenCalled();
  });

  it("resolves running:false with the timeout reason when no event fires in time", async () => {
    // Op exists but never transitions during the window.
    readOpMock.mockReturnValue({ canonical: { state: "queued" } });

    const result = await awaitOpRunning("op-3", 60);

    expect(result.running).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/did not reach running within 60ms/);
    expect(lastUnsub).toHaveBeenCalled();
  });

  it("ignores non-state_changed events and unrelated transitions until a real one fires", async () => {
    readOpMock.mockReturnValue({ canonical: { state: "queued" } });

    const promise = awaitOpRunning("op-4", 200);

    // Spam noise events first.
    lastListener!({ type: "turn_started" });
    lastListener!({ type: "state_changed", body: undefined });
    lastListener!({ type: "state_changed", body: { to: undefined } });
    // Now the real one.
    lastListener!({ type: "state_changed", body: { to: "succeeded" } });

    const result = await promise;
    expect(result).toEqual({ running: true });
  });
});

// A checkpoint-stopped op is `succeeded / iteration_checkpoint` on the state
// machine — and used to reach its parent as a plain "completed". The stop is
// read from the worker's own checkpoint event; it becomes `partial` here.
describe("awaitCanonicalOp — a checkpoint stop is partial, not completed", () => {
  const STOP = { completedTurns: 9, reason: "dry-checkpoints", detail: "two checkpoints in a row learned nothing new" };

  it("maps a succeeded op that stopped at a checkpoint to `partial`, with the PARTIAL line as its summary", async () => {
    readOpMock.mockReturnValue({ canonical: { state: "succeeded" } });
    readCheckpointStopMock.mockReturnValue(STOP);
    const result = await awaitCanonicalOp("op-partial", 200);
    expect(result?.status).toBe("partial");
    expect(result?.finalSummary).toMatch(/^PARTIAL — child op op-partial stopped at a checkpoint after 9 turns \(reason: dry-checkpoints\)/);
    expect(result?.error).toBeUndefined();
    expect(readCheckpointStopMock).toHaveBeenCalledWith("op-partial");
  });

  it("keeps a genuinely finished op `completed`", async () => {
    readOpMock.mockReturnValue({ canonical: { state: "succeeded" } });
    const result = await awaitCanonicalOp("op-done", 200);
    expect(result).toMatchObject({ status: "completed", finalSummary: "op op-done completed" });
  });

  it("never consults the checkpoint record for a failed or cancelled op", async () => {
    readCheckpointStopMock.mockReturnValue(STOP);
    readOpMock.mockReturnValue({ canonical: { state: "failed" }, lastFailureReason: "boom" });
    expect(await awaitCanonicalOp("op-failed", 200)).toMatchObject({ status: "failed", finalSummary: "boom" });
    readOpMock.mockReturnValue({ canonical: { state: "cancelled" } });
    expect(await awaitCanonicalOp("op-cancelled", 200)).toMatchObject({ status: "cancelled" });
    expect(readCheckpointStopMock).not.toHaveBeenCalled();
  });

  it("maps partial on the live path too, when the terminal event arrives before the row is persisted", async () => {
    // Disk never shows terminal (the persisted-row race); the bus does.
    readOpMock.mockReturnValue({ canonical: { state: "running" } });
    readCheckpointStopMock.mockReturnValue(STOP);
    const promise = awaitCanonicalOp("op-live", 200);
    lastListener!({ type: "state_changed", body: { to: "succeeded" } });
    const result = await promise;
    expect(result?.status).toBe("partial");
    expect(result?.finalSummary).toMatch(/^PARTIAL — child op op-live/);
  });
});
