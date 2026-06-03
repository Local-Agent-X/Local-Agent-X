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

import { awaitOpRunning } from "./await-op.js";

type Listener = (event: { type: string; body?: { to?: string } }) => void;

let lastListener: Listener | null = null;
let lastUnsub: ReturnType<typeof vi.fn> | null = null;

beforeEach(() => {
  readOpMock.mockReset();
  subscribeOpEventsMock.mockReset();
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
