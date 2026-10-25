/**
 * A launch reservation belongs to the launch that made it.
 *
 * Recovery evicts a stale worker and relaunches its op; the relaunch reserves
 * a slot (`launching`) while its adapter factory is still pending. When the
 * evicted worker's run then settles, its launch's finally used to delete the
 * op's reservation outright — the relaunch's, not its own — so the scheduler
 * undercounted in-flight work and a re-enqueue of the same op could launch it
 * a second time. The reservation now carries a per-launch owner token.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";
import type { ExecutionBackend, ExecutionBackendStartRequest } from "./execution-backend.js";

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-scheduler-launch-reservation-"));
process.env.LAX_DATA_DIR = dataDir;

const { canonicalLoopEntry, registerAdapterForOp, resetCanonicalRuntime } = await import("./index.js");
const {
  _setExecutionBackendResolverForTest,
  enqueueOp,
  evictWorker,
  pumpScheduler,
  resetScheduler,
  schedulerSnapshot,
} = await import("./scheduler.js");

const adapter = { name: "launch-reservation", version: "1" } as Adapter;

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

class SettleableBackend implements ExecutionBackend {
  readonly id = "launch-reservation-test";
  readonly adapterProvisioning = "parent" as const;
  readonly runs: Deferred<void>[] = [];
  readonly starts = vi.fn((_request: ExecutionBackendStartRequest) => {
    const run = deferred<void>();
    this.runs.push(run);
    return { done: run.promise };
  });

  place(op: Op) { return { targetId: `target-${op.id}`, disposition: "ready" as const }; }
  acceptsPlacement(): boolean { return true; }
  start(request: ExecutionBackendStartRequest): { done: Promise<void> } { return this.starts(request); }
  settleAll(): void { for (const run of this.runs) run.resolve(); }
}

function makeOp(label: string): Op {
  const task = `launch reservation ${label}`;
  return {
    id: `op-${label}-${Math.random().toString(16).slice(2)}`,
    type: "freeform",
    task,
    model: "test-model",
    contextPack: {
      task: { description: task, successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {},
      budget: { maxIterations: 4, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
      routing: { lane: "interactive" },
      secrets: { allowed: [] },
    },
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    ownerId: "test",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

let backend: SettleableBackend;
let pendingFactory: Deferred<Adapter> | null = null;

afterEach(() => {
  pendingFactory?.resolve(adapter);
  backend?.settleAll();
  resetScheduler();
  resetCanonicalRuntime();
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("scheduler launch reservations under eviction and relaunch", () => {
  it("an evicted worker settling late leaves the relaunch's reservation in place", async () => {
    backend = new SettleableBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const op = makeOp("relaunched");
    registerAdapterForOp(op.id, () => adapter);
    canonicalLoopEntry(op);
    await vi.waitFor(() => expect(backend.starts).toHaveBeenCalledTimes(1));

    // Recovery: evict the first worker, relaunch the op with an adapter
    // factory that has not resolved yet, so the relaunch holds a reservation.
    expect(evictWorker(op.id)).toBe(true);
    pendingFactory = deferred<Adapter>();
    registerAdapterForOp(op.id, () => pendingFactory!.promise);
    enqueueOp(op.id, "interactive");
    pumpScheduler();
    expect(schedulerSnapshot()).toEqual({ queueDepth: 0, activeCount: 1 });

    // The evicted worker's run settles; its launch's finally must not touch
    // the relaunch's reservation.
    backend.runs[0].resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(schedulerSnapshot()).toEqual({ queueDepth: 0, activeCount: 1 });

    // The reservation still guards against a second launch of the same op.
    enqueueOp(op.id, "interactive");
    pumpScheduler();
    expect(schedulerSnapshot()).toEqual({ queueDepth: 0, activeCount: 1 });

    pendingFactory.resolve(adapter);
    await vi.waitFor(() => expect(backend.starts).toHaveBeenCalledTimes(2));
    expect(schedulerSnapshot()).toEqual({ queueDepth: 0, activeCount: 1 });
  });
});
