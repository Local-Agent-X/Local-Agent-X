import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "./adapter-contract.js";
import type { ExecutionBackend, ExecutionBackendStartRequest } from "./execution-backend.js";

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
  resetScheduler,
} = await import("./scheduler.js");
const { recoverStaleOp } = await import("./recovery.js");

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

function submit(op: Op): void {
  registerAdapterForOp(op.id, () => adapter);
  canonicalLoopEntry(op);
}

async function waitForStarts(backend: ControlledBackend, count: number): Promise<void> {
  await vi.waitFor(() => expect(backend.starts).toHaveBeenCalledTimes(count));
}

let backend: ControlledBackend;

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

describe("scheduler execution-backend parity", () => {
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
});
