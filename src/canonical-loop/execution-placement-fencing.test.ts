import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";
import type { ExecutionBackend, ExecutionBackendStartRequest } from "./execution-backend.js";

const oldDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-placement-fence-"));
process.env.LAX_DATA_DIR = dataDir;

const { readOp, writeOp } = await import("../ops/op-store.js");
const { canonicalLoopEntry, registerAdapterForOp, resetCanonicalRuntime } = await import("./index.js");
const {
  _setExecutionBackendResolverForTest,
  enqueueOp,
  pumpScheduler,
  resetScheduler,
  scheduleQueuedRetry,
  wakeExecutionPlacement,
} = await import("./scheduler.js");

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class WaitingBackend implements ExecutionBackend {
  readonly id = "fence-backend";
  readonly runs: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  readonly starts = vi.fn((_request: ExecutionBackendStartRequest) => {
    const run = deferred();
    this.runs.push(run);
    return { done: run.promise };
  });

  place(): { targetId: string; disposition: "waiting"; wakeToken: string } {
    return { targetId: "capacity-slot", disposition: "waiting", wakeToken: "capacity" };
  }

  acceptsPlacement(placement: Parameters<ExecutionBackend["acceptsPlacement"]>[0]): boolean {
    return placement.backendId === this.id && placement.targetId === "capacity-slot";
  }

  start(request: ExecutionBackendStartRequest): { done: Promise<void> } {
    return this.starts(request);
  }

  settle(): void { for (const run of this.runs) run.resolve(); }
}

const adapter = { name: "fence", version: "1" } as Adapter;

function makeOp(label: string): Op {
  const task = `placement fence ${label}`;
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
      routing: { lane: "background" },
      secrets: { allowed: [] },
    },
    lane: "background",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    ownerId: "test",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

let backend: WaitingBackend;

function submit(candidate: Op): void {
  backend = new WaitingBackend();
  _setExecutionBackendResolverForTest(() => backend);
  registerAdapterForOp(candidate.id, () => adapter);
  canonicalLoopEntry(candidate);
}

afterEach(() => {
  backend?.settle();
  resetScheduler();
  resetCanonicalRuntime();
});

afterAll(() => {
  if (oldDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = oldDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("execution placement revision fencing", () => {
  it("cancels stale placement backoff when capacity wakes the op", async () => {
    vi.useFakeTimers();
    try {
      const candidate = makeOp("capacity-backoff");
      submit(candidate);
      scheduleQueuedRetry(candidate.id, candidate.lane, 60_000);
      const identity = { backendId: backend.id, targetId: "capacity-slot" };

      expect(wakeExecutionPlacement(candidate.id, identity, 1, "capacity")).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(backend.starts).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(backend.starts).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a stale wake when a newer waiting revision reuses the same token", async () => {
    const candidate = makeOp("same-token");
    submit(candidate);
    const previous = readOp(candidate.id)!.canonical!.executionPlacement!;
    const updated = readOp(candidate.id)!;
    updated.canonical!.executionPlacement = { ...previous, revision: 2 };
    writeOp(updated);

    expect(wakeExecutionPlacement(candidate.id, {
      backendId: backend.id,
      targetId: "capacity-slot",
    }, 1, "capacity")).toEqual({ ok: false, reason: "revision_mismatch" });
    expect(readOp(candidate.id)!.canonical!.executionPlacement).toEqual({ ...previous, revision: 2 });
    expect(backend.starts).not.toHaveBeenCalled();

    expect(wakeExecutionPlacement(candidate.id, {
      backendId: backend.id,
      targetId: "capacity-slot",
    }, 2, "capacity")).toMatchObject({ ok: true, placement: { revision: 3 } });
    await vi.waitFor(() => expect(backend.starts).toHaveBeenCalledOnce());
  });

  it("allows only one of two wakes holding the same revision fence", async () => {
    const candidate = makeOp("concurrent");
    submit(candidate);
    const identity = { backendId: backend.id, targetId: "capacity-slot" };

    expect(wakeExecutionPlacement(candidate.id, identity, 1, "capacity")).toMatchObject({ ok: true });
    expect(wakeExecutionPlacement(candidate.id, identity, 1, "capacity"))
      .toEqual({ ok: false, reason: "revision_mismatch" });
    await vi.waitFor(() => expect(backend.starts).toHaveBeenCalledOnce());
    expect(readOp(candidate.id)?.canonical?.executionPlacement?.revision).toBe(2);
  });

  it("preserves a durable wake when the local scheduler resets before its timer fires", async () => {
    const candidate = makeOp("reset");
    submit(candidate);
    const identity = { backendId: backend.id, targetId: "capacity-slot" };
    expect(wakeExecutionPlacement(candidate.id, identity, 1, "capacity")).toMatchObject({ ok: true });
    resetScheduler();
    _setExecutionBackendResolverForTest(() => backend);
    enqueueOp(candidate.id, candidate.lane);
    pumpScheduler();

    await vi.waitFor(() => expect(backend.starts).toHaveBeenCalledOnce());
    expect(backend.starts.mock.calls[0][0].placement).toMatchObject({ disposition: "ready", revision: 2 });
  });
});
