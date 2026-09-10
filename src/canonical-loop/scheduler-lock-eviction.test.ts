/**
 * Ownership pin for the scheduler's `activeLocks` map (scheduler.ts).
 *
 * The map exists so a slot's resource lock can be released WITHOUT re-reading
 * the op from disk: recovery can delete an op dir mid-flight, `readOp` then
 * returns null, and sourcing the lock off `op.resourceLocks` in that window
 * would silently skip the release and STRAND `gpu:0` forever — a permanent
 * deadlock of every local-model op.
 *
 * This pins that the release really is disk-independent. It asserts ONLY the
 * lock half of `evictWorker`; the lane-counter half of the same function still
 * goes through `readOp` and is deliberately not asserted here.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";
import type { ExecutionBackend, ExecutionBackendStartRequest } from "./execution-backend.js";

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-scheduler-lock-eviction-"));
process.env.LAX_DATA_DIR = dataDir;

const { canonicalLoopEntry, registerAdapterForOp, resetCanonicalRuntime } = await import("./index.js");
const {
  _setExecutionBackendResolverForTest,
  evictWorker,
  resetScheduler,
} = await import("./scheduler.js");
const { opDir } = await import("../ops/event-log.js");

const adapter = { name: "lock-eviction", version: "1" } as Adapter;

interface Deferred { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => { resolve = ok; });
  return { promise, resolve };
}

class LockBackend implements ExecutionBackend {
  readonly id = "lock-eviction-test";
  readonly adapterProvisioning = "parent" as const;
  readonly runs = new Map<string, Deferred>();
  readonly starts = vi.fn((request: ExecutionBackendStartRequest) => {
    const run = deferred();
    this.runs.set(request.op.id, run);
    return { done: run.promise };
  });

  place(op: Op) { return { targetId: `target-${op.id}`, disposition: "ready" as const }; }
  acceptsPlacement(): boolean { return true; }
  start(request: ExecutionBackendStartRequest): { done: Promise<void> } { return this.starts(request); }
  settleAll(): void { for (const run of this.runs.values()) run.resolve(); }
}

function makeOp(label: string, locks: string[]): Op {
  const task = `lock eviction ${label}`;
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
    resourceLocks: locks,
  };
}

function submit(op: Op): void {
  registerAdapterForOp(op.id, () => adapter);
  canonicalLoopEntry(op);
}

let backend: LockBackend;

afterEach(() => {
  backend?.settleAll();
  resetScheduler();
  resetCanonicalRuntime();
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("scheduler resource-lock ownership under eviction", () => {
  it("serializes two ops that declare the same singleton lock", async () => {
    backend = new LockBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const first = makeOp("held-a", ["gpu:0"]);
    const second = makeOp("held-b", ["gpu:0"]);
    submit(first);
    await vi.waitFor(() => expect(backend.starts).toHaveBeenCalledTimes(1));
    submit(second);

    // Second op is SKIPPED (not awaited) while the lock is held by the first.
    await new Promise((r) => setTimeout(r, 20));
    expect(backend.starts).toHaveBeenCalledTimes(1);
    expect(backend.starts.mock.calls[0][0].op.id).toBe(first.id);
  });

  it("evictWorker frees the lock from activeLocks even when the op dir is gone", async () => {
    backend = new LockBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const first = makeOp("evicted", ["gpu:0"]);
    const second = makeOp("successor", ["gpu:0"]);
    submit(first);
    await vi.waitFor(() => expect(backend.starts).toHaveBeenCalledTimes(1));
    submit(second);
    await new Promise((r) => setTimeout(r, 20));
    expect(backend.starts).toHaveBeenCalledTimes(1);

    // Recovery's mid-flight op-dir deletion: readOp(first) is now null.
    rmSync(opDir(first.id), { recursive: true, force: true });
    expect(evictWorker(first.id)).toBe(true);

    // The lock came from activeLocks, not from the (unreadable) op — so the
    // successor launches. A disk-sourced release would strand gpu:0 forever.
    await vi.waitFor(() => expect(backend.starts).toHaveBeenCalledTimes(2));
    expect(backend.starts.mock.calls[1][0].op.id).toBe(second.id);
  });
});
