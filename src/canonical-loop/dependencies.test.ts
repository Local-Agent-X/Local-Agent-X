import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";
import type {
  ExecutionBackend,
  ExecutionBackendStartWithoutAdapterRequest,
} from "./execution-backend.js";

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-dependencies-"));
process.env.LAX_DATA_DIR = dataDir;

const { canonicalLoopEntry, registerAdapterForOp, resetCanonicalRuntime } = await import("./index.js");
const {
  _setExecutionBackendResolverForTest,
  rebuildDependencyScheduling,
  resetScheduler,
} = await import("./scheduler.js");
const { opCancel } = await import("./control-api.js");
const { readOp, writeOp } = await import("../ops/op-store.js");
const { transitionOp } = await import("./state-machine.js");
const {
  InvalidOpDependencyError,
  validateDependencyBatch,
  validateOpDependencies,
} = await import("./dependencies.js");

const adapter = { name: "dependency-test", version: "1" } as Adapter;

interface Run { resolve(): void }

class DependencyBackend implements ExecutionBackend {
  readonly id = "dependency-test";
  readonly adapterProvisioning = "backend" as const;
  readonly starts = vi.fn((request: ExecutionBackendStartWithoutAdapterRequest) => {
    transitionOp(request.op, "running", "dependency_test_started");
    let resolve!: () => void;
    const done = new Promise<void>((ok) => { resolve = ok; });
    this.runs.set(request.op.id, { resolve });
    return { done };
  });
  readonly runs = new Map<string, Run>();
  place = (op: Op) => ({ targetId: `target-${op.id}`, disposition: "ready" as const });
  acceptsPlacement(): boolean { return true; }
  start(): never { throw new Error("parent adapter path used"); }
  startWithoutAdapter(request: ExecutionBackendStartWithoutAdapterRequest) {
    return this.starts(request);
  }
  settle(): void { for (const run of this.runs.values()) run.resolve(); }
  finish(opId: string): void { this.runs.get(opId)?.resolve(); }
}

function makeOp(id: string, over: Partial<Op> = {}): Op {
  return {
    id,
    type: "freeform",
    task: id,
    contextPack: {
      task: { description: id, successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {},
      budget: { maxIterations: 2, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
      routing: { lane: "build" },
      secrets: { allowed: [] },
    },
    lane: "build",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    ownerId: "owner-a",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    ...over,
  };
}

function submit(op: Op): void {
  registerAdapterForOp(op.id, () => adapter);
  canonicalLoopEntry(op);
}

function persisted(id: string, state: NonNullable<Op["canonical"]>["state"], over: Partial<Op> = {}): Op {
  const op = makeOp(id, {
    status: state === "succeeded" ? "completed" : state === "failed" ? "failed"
      : state === "cancelled" ? "cancelled" : "pending",
    canonical: { flagValue: true, state },
    ...over,
  });
  writeOp(op);
  return op;
}

async function expectStarts(backend: DependencyBackend, ids: string[]): Promise<void> {
  await vi.waitFor(() => expect(backend.starts.mock.calls.map(([request]) => request.op.id)).toEqual(ids));
}

let backend: DependencyBackend;

beforeEach(() => {
  backend = new DependencyBackend();
  _setExecutionBackendResolverForTest(() => backend);
});

afterEach(async () => {
  backend.settle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  resetScheduler();
  resetCanonicalRuntime();
  rmSync(join(dataDir, "operations"), { recursive: true, force: true });
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("durable dependency scheduling", () => {
  it("runs unrelated work while a chain is blocked and wakes each edge exactly once", async () => {
    const root = makeOp("chain-root");
    const middle = makeOp("chain-middle", { dependsOn: [root.id] });
    const leaf = makeOp("chain-leaf", { dependsOn: [middle.id] });
    const unrelated = makeOp("chain-unrelated");
    submit(root);
    submit(middle);
    submit(leaf);
    submit(unrelated);
    await expectStarts(backend, [root.id, unrelated.id]);

    transitionOp(readOp(root.id)!, "succeeded", "test_done");
    backend.finish(root.id);
    await expectStarts(backend, [root.id, unrelated.id, middle.id]);
    rebuildDependencyScheduling();
    expect(backend.starts.mock.calls.filter(([request]) => request.op.id === middle.id)).toHaveLength(1);

    transitionOp(readOp(middle.id)!, "succeeded", "test_done");
    backend.finish(middle.id);
    await expectStarts(backend, [root.id, unrelated.id, middle.id, leaf.id]);
  });

  it("wakes a diamond only after both prerequisites succeed", async () => {
    const root = makeOp("diamond-root");
    const left = makeOp("diamond-left", { dependsOn: [root.id] });
    const right = makeOp("diamond-right", { dependsOn: [root.id] });
    const joinOp = makeOp("diamond-join", { dependsOn: [left.id, right.id] });
    submit(root);
    submit(left);
    submit(right);
    submit(joinOp);
    await expectStarts(backend, [root.id]);
    transitionOp(readOp(root.id)!, "succeeded", "test_done");
    backend.finish(root.id);
    await expectStarts(backend, [root.id, left.id, right.id]);
    transitionOp(readOp(left.id)!, "succeeded", "test_done");
    backend.finish(left.id);
    expect(backend.starts.mock.calls.some(([request]) => request.op.id === joinOp.id)).toBe(false);
    transitionOp(readOp(right.id)!, "succeeded", "test_done");
    backend.finish(right.id);
    await expectStarts(backend, [root.id, left.id, right.id, joinOp.id]);
  });

  it("rebuilds waiters after restart without double-launching", async () => {
    persisted("restart-root", "succeeded");
    const dependent = persisted("restart-dependent", "queued", { dependsOn: ["restart-root"] });
    registerAdapterForOp(dependent.id, () => adapter);
    rebuildDependencyScheduling();
    await expectStarts(backend, [dependent.id]);
    rebuildDependencyScheduling();
    expect(backend.starts).toHaveBeenCalledTimes(1);
  });

  it("propagates failed and cancelled prerequisites before leasing dependents", async () => {
    const failedRoot = makeOp("failed-root");
    const failedChild = makeOp("failed-child", { dependsOn: [failedRoot.id] });
    submit(failedRoot);
    submit(failedChild);
    await expectStarts(backend, [failedRoot.id]);
    transitionOp(readOp(failedRoot.id)!, "failed", "test_failed");
    expect(readOp(failedChild.id)?.canonical?.state).toBe("failed");

    const cancelledRoot = makeOp("cancelled-root");
    const cancelledChild = makeOp("cancelled-child", { dependsOn: [cancelledRoot.id] });
    submit(cancelledRoot);
    submit(cancelledChild);
    await expectStarts(backend, [failedRoot.id, cancelledRoot.id]);
    transitionOp(readOp(cancelledRoot.id)!, "cancelling", "test_cancel");
    transitionOp(readOp(cancelledRoot.id)!, "cancelled", "test_cancelled");
    expect(readOp(cancelledChild.id)?.canonical?.state).toBe("cancelled");
    expect(backend.starts.mock.calls.some(([request]) => request.op.id.endsWith("child"))).toBe(false);
  });

  it("honors pre-lease cancellation while dependency-blocked", async () => {
    const root = makeOp("blocked-cancel-root");
    const child = makeOp("blocked-cancel-child", { dependsOn: [root.id] });
    submit(root);
    submit(child);
    await expectStarts(backend, [root.id]);
    expect(opCancel(child.id, "test").ok).toBe(true);
    await vi.waitFor(() => expect(readOp(child.id)?.canonical?.state).toBe("cancelled"));
    expect(backend.starts.mock.calls.some(([request]) => request.op.id === child.id)).toBe(false);
  });

  it("fails closed when a persisted prerequisite disappears", async () => {
    persisted("missing-root", "queued");
    const child = persisted("missing-child", "queued", { dependsOn: ["missing-root"] });
    registerAdapterForOp(child.id, () => adapter);
    rmSync(join(dataDir, "operations", "missing-root"), { recursive: true, force: true });
    rebuildDependencyScheduling();
    expect(readOp(child.id)?.canonical?.state).toBe("failed");
    expect(backend.starts).not.toHaveBeenCalled();
  });
});

describe("dependency admission", () => {
  it("rejects missing, duplicate, self, cross-owner, and cyclic dependencies", () => {
    const root = persisted("admission-root", "succeeded");
    expect(() => validateOpDependencies(makeOp("missing", { dependsOn: ["absent"] })))
      .toThrow(InvalidOpDependencyError);
    expect(() => validateOpDependencies(makeOp("traversal", { dependsOn: ["../../settings.json"] })))
      .toThrow(/invalid dependency id/);
    expect(() => validateOpDependencies(makeOp("duplicate", { dependsOn: [root.id, root.id] })))
      .toThrow(/duplicate/);
    expect(() => validateOpDependencies(makeOp("self", { dependsOn: ["self"] })))
      .toThrow(/itself/);
    expect(() => validateOpDependencies(makeOp("foreign", {
      ownerId: "owner-b", dependsOn: [root.id],
    }))).toThrow(/not authorized/);

    const first = makeOp("cycle-first", { canonical: { flagValue: true, state: "queued" } });
    const second = makeOp("cycle-second", { canonical: { flagValue: true, state: "queued" } });
    first.dependsOn = [second.id];
    second.dependsOn = [first.id];
    expect(() => validateDependencyBatch([first, second])).toThrow(/cycle/);
  });

  it("allows same-owner dependencies across sessions", () => {
    const root = persisted("cross-session-root", "succeeded", { sessionId: "session-a" });
    const child = makeOp("cross-session-child", {
      sessionId: "session-b",
      dependsOn: [root.id],
    });
    expect(validateOpDependencies(child)).toEqual([root.id]);
  });
});
