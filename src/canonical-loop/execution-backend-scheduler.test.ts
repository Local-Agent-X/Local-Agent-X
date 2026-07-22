import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "./adapter-contract.js";
import type {
  ExecutionBackend,
  ExecutionBackendStartRequest,
  ExecutionBackendStartWithoutAdapterRequest,
} from "./execution-backend.js";

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-execution-backend-scheduler-"));
process.env.LAX_DATA_DIR = dataDir;

const {
  canonicalLoopEntry,
  registerAdapterForOp,
  resetCanonicalRuntime,
} = await import("./index.js");
const {
  _setExecutionBackendResolverForTest,
  awaitIdle,
  enqueueOp,
  pumpScheduler,
  resetScheduler,
} = await import("./scheduler.js");
const { recoverStaleOp } = await import("./recovery.js");
const { readOp, writeOp } = await import("../ops/op-store.js");
const { transitionOp } = await import("./state-machine.js");
const { _setLeaseRaceHookForTest } = await import("./lease.js");
const {
  claimProcessExecution,
  readProcessExecutionClaim,
  removeProcessExecutionClaim,
} = await import("./process-execution-claim.js");

const adapter = { name: "scheduler-parity", version: "1" } as Adapter;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

class ControlledBackend implements ExecutionBackend {
  readonly id = "controlled-test";
  readonly adapterProvisioning = "parent" as const;
  readonly decisions = new Map<string, ReturnType<ExecutionBackend["place"]>>();
  readonly place = vi.fn((op: Op) => this.decisions.get(op.id)
    ?? { targetId: `target-${op.id}`, disposition: "ready" as const });
  readonly starts = vi.fn((request: ExecutionBackendStartRequest) => {
    if (this.throwOnStart.delete(request.op.id)) throw new Error("worker start threw");
    const run = deferred();
    const existing = this.runs.get(request.op.id) ?? [];
    existing.push(run);
    this.runs.set(request.op.id, existing);
    return { done: run.promise };
  });
  readonly runs = new Map<string, Deferred[]>();
  readonly throwOnStart = new Set<string>();

  acceptsPlacement(): boolean { return true; }

  start(request: ExecutionBackendStartRequest): { done: Promise<void> } {
    return this.starts(request);
  }

  latest(opId: string): Deferred {
    const runs = this.runs.get(opId);
    if (!runs?.length) throw new Error(`No run for ${opId}`);
    return runs[runs.length - 1];
  }

  settleAll(): void {
    for (const runs of this.runs.values()) for (const run of runs) run.resolve();
  }
}

function makeOp(label: string, lane: Op["lane"] = "interactive", locks?: string[]): Op {
  const task = `backend scheduler ${label}`;
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
    resourceLocks: locks,
  };
}

function submit(op: Op, factory: () => Adapter | Promise<Adapter> = () => adapter): void {
  registerAdapterForOp(op.id, factory);
  canonicalLoopEntry(op);
}

async function waitForStarts(backend: ControlledBackend, count: number): Promise<void> {
  await vi.waitFor(() => expect(backend.starts).toHaveBeenCalledTimes(count));
}

let backend: ControlledBackend;

afterEach(() => {
  _setLeaseRaceHookForTest(null);
  backend?.settleAll();
  resetScheduler();
  resetCanonicalRuntime();
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("scheduler execution-backend parity", () => {
  it("does not construct or pass the parent adapter for a backend-owned adapter", async () => {
    const run = deferred();
    const startWithoutAdapter = vi.fn((_request: ExecutionBackendStartWithoutAdapterRequest) => (
      { done: run.promise }
    ));
    const backendOwned: ExecutionBackend = {
      id: "backend-owned-test",
      adapterProvisioning: "backend",
      place: (op) => ({ targetId: `target-${op.id}`, disposition: "ready" }),
      acceptsPlacement: () => true,
      start: () => { throw new Error("parent adapter path used"); },
      startWithoutAdapter,
    };
    _setExecutionBackendResolverForTest(() => backendOwned);
    const op = makeOp("backend-owned");
    const parentFactory = vi.fn(() => { throw new Error("parent factory used"); });
    submit(op, parentFactory);

    await vi.waitFor(() => expect(startWithoutAdapter).toHaveBeenCalledOnce());
    expect(parentFactory).not.toHaveBeenCalled();
    expect(startWithoutAdapter).toHaveBeenCalledWith({
      op: expect.objectContaining({ id: op.id }),
      placement: expect.objectContaining({ backendId: backendOwned.id }),
    });
    transitionOp(startWithoutAdapter.mock.calls[0][0].op, "running", "test_claimed");
    run.resolve();
  });

  it("retries a backend-owned clean settlement that never durably claimed the op", async () => {
    const runs: Deferred[] = [];
    const startWithoutAdapter = vi.fn((_request: ExecutionBackendStartWithoutAdapterRequest) => {
      const run = deferred();
      runs.push(run);
      return { done: run.promise };
    });
    const backendOwned: ExecutionBackend = {
      id: "backend-owned-clean-settlement",
      adapterProvisioning: "backend",
      place: (op) => ({ targetId: `target-${op.id}`, disposition: "ready" }),
      acceptsPlacement: () => true,
      start: () => { throw new Error("parent adapter path used"); },
      startWithoutAdapter,
    };
    _setExecutionBackendResolverForTest(() => backendOwned);
    const op = makeOp("backend-clean-before-claim", "background");
    submit(op, () => { throw new Error("parent factory used"); });
    await vi.waitFor(() => expect(startWithoutAdapter).toHaveBeenCalledTimes(1));

    runs[0].resolve();
    await vi.waitFor(() => expect(startWithoutAdapter).toHaveBeenCalledTimes(2));
    expect(readOp(op.id)?.attemptCount).toBe(1);
    const claimed = startWithoutAdapter.mock.calls[1][0].op;
    transitionOp(claimed, "running", "test_claimed");
    runs[1].resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(startWithoutAdapter).toHaveBeenCalledTimes(2);
  });

  it.each(["running", "failed"] as const)(
    "does not retry a clean backend-owned settlement after durable state is %s",
    async (state) => {
      const run = deferred();
      const startWithoutAdapter = vi.fn((_request: ExecutionBackendStartWithoutAdapterRequest) => (
        { done: run.promise }
      ));
      const backendOwned: ExecutionBackend = {
        id: `backend-owned-${state}`,
        adapterProvisioning: "backend",
        place: (op) => ({ targetId: `target-${op.id}`, disposition: "ready" }),
        acceptsPlacement: () => true,
        start: () => { throw new Error("parent adapter path used"); },
        startWithoutAdapter,
      };
      _setExecutionBackendResolverForTest(() => backendOwned);
      const op = makeOp(`backend-owned-${state}`);
      submit(op, () => { throw new Error("parent factory used"); });
      await vi.waitFor(() => expect(startWithoutAdapter).toHaveBeenCalledOnce());
      const launched = startWithoutAdapter.mock.calls[0][0].op;
      transitionOp(launched, "running", "test_claimed");
      if (state === "failed") transitionOp(launched, "failed", "test_terminal");

      run.resolve();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(startWithoutAdapter).toHaveBeenCalledOnce();
      expect(readOp(op.id)?.canonical?.state).toBe(state);
    },
  );

  it("starts one backend execution exactly once for one runnable op", async () => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const op = makeOp("once");
    submit(op);

    await waitForStarts(backend, 1);
    expect(backend.starts.mock.calls[0][0]).toEqual({
      op: expect.objectContaining({ id: op.id }),
      adapter,
      placement: expect.objectContaining({
        backendId: backend.id,
        targetId: `target-${op.id}`,
        disposition: "ready",
      }),
    });
    backend.latest(op.id).resolve();
  });

  it("drains queued A then B through the default in-process backend", async () => {
    const turnOrder: string[] = [];
    const defaultAdapter: Adapter = {
      name: "default-backend-parity",
      version: "1",
      async runTurn(input: TurnInput, _report: (report: AdapterReport) => void): Promise<TurnResult> {
        turnOrder.push(input.opId);
        return {
          providerState: {
            adapterName: "default-backend-parity",
            adapterVersion: "1",
            providerPayload: {},
          },
          terminalReason: "done",
        };
      },
      async abort(): Promise<void> {},
    };
    const first = makeOp("default-a", "background");
    const second = makeOp("default-b", "background");
    registerAdapterForOp(first.id, () => defaultAdapter);
    registerAdapterForOp(second.id, () => defaultAdapter);

    canonicalLoopEntry(first);
    canonicalLoopEntry(second);
    await awaitIdle();

    expect(turnOrder).toEqual([first.id, second.id]);
  });

  it.each(["resolved", "rejected"] as const)(
    "drains queued A then B through an injected backend after A %s",
    async (outcome) => {
      backend = new ControlledBackend();
      _setExecutionBackendResolverForTest(() => backend);
      const first = makeOp(`failure-${outcome}-a`, "background");
      const second = makeOp(`failure-${outcome}-b`, "background");
      submit(first);
      submit(second);

      await waitForStarts(backend, 1);
      if (outcome === "resolved") backend.latest(first.id).resolve();
      else backend.latest(first.id).reject(new Error("worker failed"));
      await waitForStarts(backend, 2);
      expect(backend.starts.mock.calls.map(([request]) => request.op.id))
        .toEqual([first.id, second.id]);
      backend.latest(second.id).resolve();
    },
  );

  it("releases the lane after backend start throws", async () => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const first = makeOp("throw-a", "background");
    const second = makeOp("throw-b", "background");
    backend.throwOnStart.add(first.id);
    submit(first);
    submit(second);

    await waitForStarts(backend, 2);
    expect(backend.starts.mock.calls.map(([request]) => request.op.id)).toEqual([first.id, second.id]);
    backend.latest(second.id).resolve();
    await waitForStarts(backend, 3);
    expect(backend.starts.mock.calls.map(([request]) => request.op.id))
      .toEqual([first.id, second.id, first.id]);
    backend.latest(first.id).resolve();
  });

  it("terminalizes an adapter factory throw before backend ownership", async () => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const op = makeOp("factory-throw", "background");
    const factory = vi.fn<() => Adapter | Promise<Adapter>>()
      .mockRejectedValue(new Error("factory failed"));
    submit(op, factory);

    await vi.waitFor(() => expect(readOp(op.id)?.canonical?.state).toBe("failed"));
    expect(factory).toHaveBeenCalledOnce();
    expect(backend.starts).not.toHaveBeenCalled();
    expect(readOp(op.id)?.attemptCount).toBe(0);
  });

  it("requeues exactly once when done rejects while durable state remains queued", async () => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const op = makeOp("queued-reject", "background");
    submit(op);
    await waitForStarts(backend, 1);

    backend.latest(op.id).reject(new Error("child exited before claim"));
    await waitForStarts(backend, 2);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(backend.starts).toHaveBeenCalledTimes(2);
    expect(readOp(op.id)?.attemptCount).toBe(1);
    backend.latest(op.id).resolve();
  });

  it.each(["running", "failed"] as const)(
    "does not requeue a rejected handle after durable state is %s",
    async (state) => {
      backend = new ControlledBackend();
      _setExecutionBackendResolverForTest(() => backend);
      const op = makeOp(`owned-${state}`);
      submit(op);
      await waitForStarts(backend, 1);
      const launched = backend.starts.mock.calls[0][0].op;
      transitionOp(launched, "running", "test_owned");
      if (state === "failed") transitionOp(launched, "failed", "test_terminal");

      backend.latest(op.id).reject(new Error("late transport rejection"));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(backend.starts).toHaveBeenCalledTimes(1);
      expect(readOp(op.id)?.canonical?.state).toBe(state);
    },
  );

  it("terminalizes exhausted launch failure and drains the next locked op", async () => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const first = makeOp("exhausted", "interactive", ["test:launch"]);
    first.retryPolicy = { maxRecoveryAttempts: 0, backoffMs: [] };
    const second = makeOp("after-exhausted", "interactive", ["test:launch"]);
    backend.throwOnStart.add(first.id);
    submit(first);
    submit(second);

    await waitForStarts(backend, 2);
    expect(backend.starts.mock.calls.map(([request]) => request.op.id)).toEqual([first.id, second.id]);
    expect(readOp(first.id)?.canonical?.state).toBe("failed");
    backend.latest(second.id).resolve();
  });

  it("does not double-launch when enqueue and pump race adapter construction", async () => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const op = makeOp("pump-race");
    let releaseFactory!: (value: Adapter) => void;
    const factory = vi.fn(() => new Promise<Adapter>(resolve => { releaseFactory = resolve; }));
    submit(op, factory);
    enqueueOp(op.id, op.lane as Op["lane"]);
    pumpScheduler();
    pumpScheduler();
    releaseFactory(adapter);

    await waitForStarts(backend, 1);
    expect(factory).toHaveBeenCalledOnce();
    expect(backend.starts).toHaveBeenCalledOnce();
    backend.latest(op.id).resolve();
  });

  it("preserves lane concurrency limits", async () => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const first = makeOp("lane-a", "background");
    const second = makeOp("lane-b", "background");
    submit(first);
    submit(second);

    await waitForStarts(backend, 1);
    expect(backend.starts.mock.calls[0][0].op.id).toBe(first.id);
    backend.latest(first.id).resolve();
    await waitForStarts(backend, 2);
    expect(backend.starts.mock.calls[1][0].op.id).toBe(second.id);
    backend.latest(second.id).resolve();
  });

  it("holds and releases resource locks around backend execution", async () => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const first = makeOp("lock-a", "interactive", ["test:singleton"]);
    const second = makeOp("lock-b", "interactive", ["test:singleton"]);
    submit(first);
    submit(second);

    await waitForStarts(backend, 1);
    expect(backend.starts.mock.calls[0][0].op.id).toBe(first.id);
    backend.latest(first.id).resolve();
    await waitForStarts(backend, 2);
    expect(backend.starts.mock.calls[1][0].op.id).toBe(second.id);
    backend.latest(second.id).resolve();
  });

  it("releases the acquired lock snapshot when failover mutates durable locks", async () => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const first = makeOp("lock-swap-a", "interactive", ["batch:test:slot:0"]);
    const second = makeOp("lock-swap-b", "interactive", ["batch:test:slot:0"]);
    submit(first);
    submit(second);

    await waitForStarts(backend, 1);
    backend.starts.mock.calls[0][0].op.resourceLocks = ["replacement:provider-lock"];
    backend.latest(first.id).resolve();
    await waitForStarts(backend, 2);
    expect(backend.starts.mock.calls[1][0].op.id).toBe(second.id);
    backend.latest(second.id).resolve();
  });

  it("starts a replacement through the backend after recovery evicts the stale execution", async () => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const op = makeOp("recovery");
    submit(op);
    await waitForStarts(backend, 1);

    expect(recoverStaleOp(op.id)).toMatchObject({ ok: true, kind: "recovered" });
    await waitForStarts(backend, 2);
    expect(backend.starts.mock.calls.map(([request]) => request.op.id)).toEqual([op.id, op.id]);
    backend.settleAll();
  });

  it.each([
    { label: "fresh-live", heartbeatAgeMs: 0, pid: process.pid, protected: true },
    { label: "stale-live", heartbeatAgeMs: 30_001, pid: process.pid, protected: false },
    { label: "fresh-dead", heartbeatAgeMs: 0, pid: 2_147_483_647, protected: false },
  ])("correlates $label process ownership with canonical recovery", async ({
    label,
    heartbeatAgeMs,
    pid,
    protected: isProtected,
  }) => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const op = makeOp(`process-claim-${label}`, "background");
    submit(op);
    await waitForStarts(backend, 1);

    const heartbeatAt = new Date(Date.now() - heartbeatAgeMs).toISOString();
    const claim = {
      schemaVersion: 1 as const,
      opId: op.id,
      backendId: "local-process",
      targetId: "canonical-worker-process-v1",
      placementRevision: 1,
      token: `token-${label}`,
      pid,
      processStartedAt: heartbeatAt,
      heartbeatAt,
    };
    expect(claimProcessExecution(claim)).toBe(true);

    const outcome = recoverStaleOp(op.id);
    if (isProtected) {
      expect(outcome).toEqual({ ok: false, kind: "lease_fresh" });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(backend.starts).toHaveBeenCalledTimes(1);
      expect(readProcessExecutionClaim(op.id)).toEqual(claim);
      expect(removeProcessExecutionClaim(claim)).toBe(true);
    } else {
      expect(outcome).toMatchObject({ ok: true, kind: "recovered" });
      await waitForStarts(backend, 2);
      expect(readProcessExecutionClaim(op.id)).toBeNull();
    }
  });

  it("rechecks process ownership under the recovery lock before relaunch", async () => {
    backend = new ControlledBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const op = makeOp("process-claim-concurrent", "background");
    submit(op);
    await waitForStarts(backend, 1);

    const persisted = readOp(op.id)!;
    persisted.canonical!.leaseOwner = "stale-canonical-owner";
    persisted.canonical!.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    writeOp(persisted);

    const now = new Date().toISOString();
    const claim = {
      schemaVersion: 1 as const,
      opId: op.id,
      backendId: "local-process",
      targetId: "canonical-worker-process-v1",
      placementRevision: 1,
      token: "token-concurrent",
      pid: process.pid,
      processStartedAt: now,
      heartbeatAt: now,
    };
    _setLeaseRaceHookForTest(point => {
      if (point !== "before_recovery_lock") return;
      _setLeaseRaceHookForTest(null);
      expect(claimProcessExecution(claim)).toBe(true);
    });

    expect(recoverStaleOp(op.id)).toEqual({ ok: false, kind: "lease_fresh" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(backend.starts).toHaveBeenCalledTimes(1);
    expect(readOp(op.id)?.canonical?.leaseOwner).toBe("stale-canonical-owner");
    expect(readProcessExecutionClaim(op.id)).toEqual(claim);
    expect(removeProcessExecutionClaim(claim)).toBe(true);
  });
});
