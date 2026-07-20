import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "./adapter-contract.js";
import type {
  ExecutionBackend,
  ExecutionBackendStartRequest,
  ExecutionPlacementDecision,
} from "./execution-backend.js";

const oldDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-execution-placement-"));
process.env.LAX_DATA_DIR = dataDir;

const { _setStrictOpWriteFailureForTest, readOp, writeOp } = await import("../ops/op-store.js");
const {
  canonicalLoopEntry,
  opCancel,
  opPause,
  opResume,
  registerAdapterForOp,
  resetCanonicalRuntime,
} = await import("./index.js");
const {
  _setExecutionBackendResolverForTest,
  awaitIdle,
  enqueueOp,
  pumpScheduler,
  resetScheduler,
  wakeExecutionPlacement,
} = await import("./scheduler.js");

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class PlacementBackend implements ExecutionBackend {
  readonly id = "placement-test";
  readonly decisions = new Map<string, ExecutionPlacementDecision>();
  readonly place = vi.fn((op: Op) => this.decisions.get(op.id)
    ?? { targetId: `target-${op.id}`, disposition: "ready" as const });
  readonly starts = vi.fn((request: ExecutionBackendStartRequest) => {
    const run = deferred();
    this.runs.set(request.op.id, run);
    return { done: run.promise };
  });
  readonly runs = new Map<string, Deferred>();

  acceptsPlacement(placement: Parameters<ExecutionBackend["acceptsPlacement"]>[0]): boolean {
    return placement.backendId === this.id;
  }

  start(request: ExecutionBackendStartRequest): { done: Promise<void> } {
    return this.starts(request);
  }

  settle(): void {
    for (const run of this.runs.values()) run.resolve();
  }
}

const adapter = { name: "placement", version: "1" } as Adapter;

function op(label: string, lane: Op["lane"] = "interactive"): Op {
  const task = `placement ${label}`;
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
      routing: { lane },
      secrets: { allowed: [] },
    },
    lane,
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    ownerId: "test",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

function submit(candidate: Op): void {
  registerAdapterForOp(candidate.id, () => adapter);
  canonicalLoopEntry(candidate);
}

let backend: PlacementBackend | undefined;

afterEach(() => {
  _setStrictOpWriteFailureForTest(null);
  backend?.settle();
  backend = undefined;
  resetScheduler();
  resetCanonicalRuntime();
});

afterAll(() => {
  if (oldDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = oldDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("durable execution placement", () => {
  it("parks a waiting target without blocking later work, then accepts only its exact wake", async () => {
    backend = new PlacementBackend();
    _setExecutionBackendResolverForTest(() => backend!);
    const waiting = op("waiting", "background");
    const healthy = op("healthy", "background");
    backend.decisions.set(waiting.id, {
      targetId: "process-slot-7",
      disposition: "waiting",
      wakeToken: "wake-7",
    });

    submit(waiting);
    submit(healthy);
    await vi.waitFor(() => expect(backend!.starts).toHaveBeenCalledTimes(1));
    expect(backend.starts.mock.calls[0][0].op.id).toBe(healthy.id);
    expect(readOp(waiting.id)?.canonical?.executionPlacement).toMatchObject({
      backendId: backend.id,
      targetId: "process-slot-7",
      disposition: "waiting",
      wakeToken: "wake-7",
      revision: 1,
    });

    expect(wakeExecutionPlacement(waiting.id, {
      backendId: backend.id,
      targetId: "stale-slot",
    }, "wake-7")).toEqual({ ok: false, reason: "identity_mismatch" });
    expect(wakeExecutionPlacement(waiting.id, {
      backendId: backend.id,
      targetId: "process-slot-7",
    }, "stale-token")).toEqual({ ok: false, reason: "token_mismatch" });

    backend.runs.get(healthy.id)!.resolve();
    const wake = wakeExecutionPlacement(waiting.id, {
      backendId: backend.id,
      targetId: "process-slot-7",
    }, "wake-7");
    expect(wake).toMatchObject({ ok: true, placement: { disposition: "ready", revision: 2 } });
    await vi.waitFor(() => expect(backend!.starts).toHaveBeenCalledTimes(2));
    expect(backend.starts.mock.calls[1][0].placement).toMatchObject({
      targetId: "process-slot-7",
      wakeRequestedAt: expect.any(String),
      revision: 2,
    });
  });

  it("restarts on the exact persisted target without re-selecting placement", async () => {
    backend = new PlacementBackend();
    _setExecutionBackendResolverForTest(() => backend!);
    const candidate = op("restart");
    submit(candidate);
    await vi.waitFor(() => expect(backend!.starts).toHaveBeenCalledOnce());
    const first = backend.starts.mock.calls[0][0].placement;
    backend.runs.get(candidate.id)!.resolve();
    await awaitIdle();

    resetScheduler();
    resetCanonicalRuntime();
    backend = new PlacementBackend();
    backend.place.mockImplementation(() => { throw new Error("must not re-place"); });
    _setExecutionBackendResolverForTest(() => backend!);
    registerAdapterForOp(candidate.id, () => adapter);
    enqueueOp(candidate.id, candidate.lane);
    pumpScheduler();

    await vi.waitFor(() => expect(backend!.starts).toHaveBeenCalledOnce());
    expect(backend.place).not.toHaveBeenCalled();
    expect(backend.starts.mock.calls[0][0].placement).toEqual(first);
  });

  it("fails malformed placement closed and still dispatches healthy work", async () => {
    backend = new PlacementBackend();
    _setExecutionBackendResolverForTest(() => backend!);
    const bad = op("malformed");
    const healthy = op("after-malformed");
    submit(bad);
    await vi.waitFor(() => expect(backend!.starts).toHaveBeenCalledOnce());
    backend.runs.get(bad.id)!.resolve();
    await awaitIdle();
    const stored = readOp(bad.id)!;
    stored.canonical!.executionPlacement = { backendId: backend.id } as never;
    writeOp(stored);
    resetScheduler();
    resetCanonicalRuntime();
    _setExecutionBackendResolverForTest(() => backend!);
    registerAdapterForOp(bad.id, () => adapter);
    registerAdapterForOp(healthy.id, () => adapter);
    canonicalLoopEntry(healthy);
    enqueueOp(bad.id, bad.lane);
    pumpScheduler();

    await vi.waitFor(() => expect(readOp(bad.id)?.canonical?.state).toBe("failed"));
    await vi.waitFor(() => expect(backend!.starts.mock.calls.some(([r]) => r.op.id === healthy.id)).toBe(true));
  });

  it("fails a persisted target drift closed before backend start", async () => {
    backend = new PlacementBackend();
    _setExecutionBackendResolverForTest(() => backend!);
    const candidate = op("target-drift");
    submit(candidate);
    await vi.waitFor(() => expect(backend!.starts).toHaveBeenCalledOnce());
    backend.runs.get(candidate.id)!.resolve();
    await awaitIdle();
    const stored = readOp(candidate.id)!;
    stored.canonical!.executionPlacement!.targetId = "unrecognized-target";
    writeOp(stored);
    resetScheduler();
    resetCanonicalRuntime();
    vi.spyOn(backend, "acceptsPlacement").mockReturnValue(false);
    _setExecutionBackendResolverForTest(() => backend!);
    registerAdapterForOp(candidate.id, () => adapter);
    enqueueOp(candidate.id, candidate.lane);
    pumpScheduler();

    await vi.waitFor(() => expect(readOp(candidate.id)?.canonical?.state).toBe("failed"));
    expect(backend.starts).toHaveBeenCalledTimes(1);
  });

  it("retries transient placement persistence failure without starting ambiguously", async () => {
    backend = new PlacementBackend();
    _setExecutionBackendResolverForTest(() => backend!);
    const candidate = op("persist-retry");
    _setStrictOpWriteFailureForTest(Object.assign(new Error("disk busy"), { code: "EBUSY" }));
    submit(candidate);

    await vi.waitFor(() => expect(backend!.starts).toHaveBeenCalledOnce());
    expect(readOp(candidate.id)?.canonical?.state).toBe("queued");
    expect(readOp(candidate.id)?.canonical?.executionPlacement).toMatchObject({
      backendId: backend.id,
      disposition: "ready",
    });
  });

  it("cancels a waiting placement without requiring the unavailable target", async () => {
    backend = new PlacementBackend();
    _setExecutionBackendResolverForTest(() => backend!);
    const candidate = op("cancel-waiting");
    backend.decisions.set(candidate.id, {
      targetId: "container-pool",
      disposition: "waiting",
      wakeToken: "capacity-wake",
    });
    submit(candidate);
    expect(backend.starts).not.toHaveBeenCalled();

    expect(opCancel(candidate.id, "test")).toEqual({ ok: true });
    await vi.waitFor(() => expect(readOp(candidate.id)?.canonical?.state).toBe("cancelled"));
    expect(backend.starts).not.toHaveBeenCalled();
  });

  it("preserves placement identity across pause and resume", async () => {
    let turns = 0;
    const pausingAdapter: Adapter = {
      name: "pause-placement",
      version: "1",
      async runTurn(input: TurnInput, _report: (report: AdapterReport) => void): Promise<TurnResult> {
        turns += 1;
        if (turns === 1) opPause(input.opId, "test");
        return {
          providerState: { adapterName: "pause-placement", adapterVersion: "1", providerPayload: {} },
          ...(turns === 1 ? {} : { terminalReason: "done" as const }),
        };
      },
      async abort(): Promise<void> {},
    };
    const candidate = op("pause-resume");
    registerAdapterForOp(candidate.id, () => pausingAdapter);
    canonicalLoopEntry(candidate);
    await awaitIdle();
    expect(readOp(candidate.id)?.canonical?.state).toBe("paused");
    const before = readOp(candidate.id)?.canonical?.executionPlacement;

    expect(opResume(candidate.id, "test")).toEqual({ ok: true });
    await awaitIdle();
    expect(readOp(candidate.id)?.canonical?.state).toBe("succeeded");
    expect(readOp(candidate.id)?.canonical?.executionPlacement).toEqual(before);
  });
});
