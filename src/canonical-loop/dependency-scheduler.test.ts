/**
 * The coordinator's `terminal` re-gates only the ops waiting on the finished
 * prerequisite. It used to rebuild the whole waiter index first, which reads
 * every op ever persisted on every completion; the index is maintained by
 * every submission and gate in this process, so the scan belongs to boot
 * (`rebuild`) alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../ops/types.js";

const h = vi.hoisted(() => ({
  ops: new Map<string, Op>(),
  readiness: new Map<string, { kind: "runnable" } | { kind: "blocked"; prerequisiteId: string }>(),
  waiters: new Map<string, Set<string>>(),
  rebuild: vi.fn(() => [] as Op[]),
}));

vi.mock("../ops/op-store.js", () => ({ readOp: (id: string) => h.ops.get(id) ?? null }));
vi.mock("./state-machine.js", () => ({ transitionOp: vi.fn(), IllegalTransitionError: class extends Error {} }));
vi.mock("./dependency-batch.js", () => ({ dependencyBatchAdmissionError: () => null }));
vi.mock("./dependencies.js", () => ({
  rebuildDependencyWaiterIndex: h.rebuild,
  resetDependencyWaiterIndex: () => h.waiters.clear(),
  registerDependencyWaiter: (op: Op) => {
    for (const id of op.dependsOn ?? []) {
      if (!h.waiters.has(id)) h.waiters.set(id, new Set());
      h.waiters.get(id)!.add(op.id);
    }
  },
  unregisterDependencyWaiter: (opId: string) => { for (const set of h.waiters.values()) set.delete(opId); },
  dependencyWaitersFor: (id: string) => [...(h.waiters.get(id) ?? [])],
  evaluateDependencyReadiness: (op: Op) => h.readiness.get(op.id) ?? { kind: "runnable" },
}));

import { DependencySchedulerCoordinator } from "./dependency-scheduler.js";

function op(id: string, dependsOn: string[]): Op {
  const o = { id, lane: "build", dependsOn, canonical: { state: "queued" } } as unknown as Op;
  h.ops.set(id, o);
  return o;
}

describe("DependencySchedulerCoordinator.terminal", () => {
  const enqueue = vi.fn();
  const pump = vi.fn();
  let coordinator: DependencySchedulerCoordinator;

  beforeEach(() => {
    h.ops.clear();
    h.readiness.clear();
    h.waiters.clear();
    vi.clearAllMocks();
    coordinator = new DependencySchedulerCoordinator({ enqueue, pump });
  });

  it("wakes a waiter registered by an earlier gate without rescanning the op store", () => {
    const root = op("root", []);
    const dependent = op("dependent", [root.id]);
    h.readiness.set(dependent.id, { kind: "blocked", prerequisiteId: root.id });
    expect(coordinator.gate(dependent)).toBe("blocked");

    h.readiness.set(dependent.id, { kind: "runnable" });
    coordinator.terminal(root.id);

    expect(enqueue).toHaveBeenCalledWith(dependent.id, "build");
    expect(pump).toHaveBeenCalledTimes(1);
    expect(h.rebuild).not.toHaveBeenCalled();
  });

  it("a completion nobody waits on touches no op and still pumps", () => {
    coordinator.terminal("lonely");
    expect(enqueue).not.toHaveBeenCalled();
    expect(pump).toHaveBeenCalledTimes(1);
    expect(h.rebuild).not.toHaveBeenCalled();
  });

  it("rebuild is the one path that scans persisted ops", () => {
    coordinator.rebuild();
    expect(h.rebuild).toHaveBeenCalledTimes(1);
  });
});
