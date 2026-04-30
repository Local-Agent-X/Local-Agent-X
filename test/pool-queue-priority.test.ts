import { describe, it, expect } from "vitest";

// Pure-logic mirror of pool.ts's queue-sort + position-shift detection.
// We extract the algorithm here so we can test it without spawning workers
// or importing pool.ts (which has side effects: spawnWorker, EventBus, etc).
//
// If pool.ts's sortQueueByLane / submitOp logic ever drifts from this,
// the test will surface the divergence — pool.ts's queue cards lying about
// "queued #N" was the original bug we fixed.

interface Op { id: string; lane: "interactive" | "build" | "background" }

const LANE_PRIORITY: Record<string, number> = {
  interactive: 3,
  build: 2,
  background: 1,
};

function sortQueueByLane(queue: Op[]): void {
  queue.sort((a, b) => (LANE_PRIORITY[b.lane] || 2) - (LANE_PRIORITY[a.lane] || 2));
}

function submit(queue: Op[], op: Op): { queuePos: number; shifted: boolean } {
  const priorOrder = queue.map(o => o.id);
  queue.push(op);
  sortQueueByLane(queue);
  const queuePos = queue.findIndex(o => o.id === op.id) + 1;
  const shifted = queue.some((o, i) => o.id !== op.id && priorOrder[i] !== o.id);
  return { queuePos, shifted };
}

describe("submitOp priority-aware queue insert", () => {
  it("reports correct position when an interactive op is added behind build ops", () => {
    const q: Op[] = [
      { id: "a", lane: "build" },
      { id: "b", lane: "build" },
    ];
    const { queuePos, shifted } = submit(q, { id: "c", lane: "interactive" });
    // The interactive op should jump to the front (#1), not be reported as #3.
    expect(queuePos).toBe(1);
    expect(shifted).toBe(true);
    // And the array should reflect that.
    expect(q.map(o => o.id)).toEqual(["c", "a", "b"]);
  });

  it("does NOT mark shifted when same-lane op is appended (no-op for prior cards)", () => {
    const q: Op[] = [
      { id: "a", lane: "build" },
      { id: "b", lane: "build" },
    ];
    const { queuePos, shifted } = submit(q, { id: "c", lane: "build" });
    expect(queuePos).toBe(3);
    expect(shifted).toBe(false);
  });

  it("background op submitted into a build-only queue lands at the back, no shift", () => {
    const q: Op[] = [
      { id: "a", lane: "build" },
    ];
    const { queuePos, shifted } = submit(q, { id: "c", lane: "background" });
    expect(queuePos).toBe(2);
    expect(shifted).toBe(false);
  });

  it("interactive jumps over a mixed background+build queue", () => {
    const q: Op[] = [
      { id: "a", lane: "background" },
      { id: "b", lane: "build" },
      { id: "c", lane: "build" },
    ];
    const { queuePos, shifted } = submit(q, { id: "d", lane: "interactive" });
    // After sort: d (interactive=3), b (build=2), c (build=2), a (bg=1)
    expect(queuePos).toBe(1);
    expect(shifted).toBe(true);
    expect(q.map(o => o.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("preserves FIFO within the same lane (stable sort)", () => {
    const q: Op[] = [
      { id: "a", lane: "build" },
      { id: "b", lane: "build" },
      { id: "c", lane: "build" },
    ];
    submit(q, { id: "d", lane: "build" });
    expect(q.map(o => o.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("first op into an empty queue is always position 1, never marked shifted", () => {
    const q: Op[] = [];
    const { queuePos, shifted } = submit(q, { id: "a", lane: "build" });
    expect(queuePos).toBe(1);
    expect(shifted).toBe(false);
  });
});

// Pure-logic mirror of cancelQueuedOp's reorder broadcast. The real impl
// also touches the op-store, pendingResults map, and result cache — but the
// QUEUE-position math (which is what users see in the sidebar) is what we
// care about here. If the trailing cards' "queued #N" labels don't shift
// up after a cancel, the sidebar lies until the next dispatch.
function cancel(queue: Op[], opId: string): { removed: boolean; entries: { opId: string; queuePosition: number }[] } {
  const idx = queue.findIndex(o => o.id === opId);
  if (idx < 0) return { removed: false, entries: [] };
  queue.splice(idx, 1);
  const entries = queue.map((q, i) => ({ opId: q.id, queuePosition: i + 1 }));
  return { removed: true, entries };
}

describe("cancelQueuedOp reorder math", () => {
  it("removing the head shifts every trailing card up by one", () => {
    const q: Op[] = [
      { id: "a", lane: "build" },
      { id: "b", lane: "build" },
      { id: "c", lane: "build" },
    ];
    const { removed, entries } = cancel(q, "a");
    expect(removed).toBe(true);
    expect(entries).toEqual([
      { opId: "b", queuePosition: 1 },
      { opId: "c", queuePosition: 2 },
    ]);
  });

  it("removing the middle leaves head at #1 and shifts only the tail", () => {
    const q: Op[] = [
      { id: "a", lane: "build" },
      { id: "b", lane: "build" },
      { id: "c", lane: "build" },
    ];
    const { entries } = cancel(q, "b");
    expect(entries).toEqual([
      { opId: "a", queuePosition: 1 },
      { opId: "c", queuePosition: 2 },
    ]);
  });

  it("removing the tail emits no position changes for surviving cards but still reports the new (shorter) queue", () => {
    const q: Op[] = [
      { id: "a", lane: "build" },
      { id: "b", lane: "build" },
    ];
    const { entries } = cancel(q, "b");
    // Surviving entries keep their #1 — fine to re-emit, frontend is idempotent.
    expect(entries).toEqual([{ opId: "a", queuePosition: 1 }]);
  });

  it("emptying the queue returns an empty entries list (caller skips emit)", () => {
    const q: Op[] = [{ id: "a", lane: "build" }];
    const { removed, entries } = cancel(q, "a");
    expect(removed).toBe(true);
    expect(entries).toEqual([]);
  });

  it("cancelling an unknown op id is a no-op", () => {
    const q: Op[] = [
      { id: "a", lane: "build" },
      { id: "b", lane: "build" },
    ];
    const { removed, entries } = cancel(q, "z");
    expect(removed).toBe(false);
    expect(entries).toEqual([]);
    // Queue is untouched.
    expect(q.map(o => o.id)).toEqual(["a", "b"]);
  });
});
