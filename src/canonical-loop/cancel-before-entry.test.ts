/**
 * A Stop recorded on an op BEFORE it enters the canonical loop must still
 * cancel it.
 *
 * The agent runner persists its op, and only then submits it with
 * `canonicalLoopEntry`. A Stop in that window goes through `opCancel`, which
 * merges `cancelRequestedAt` onto the op's file. The entry then persists the
 * caller's in-memory op — whose cancel column is still unset — and a bare
 * write would erase the Stop, so the pre-lease check found nothing and the op
 * ran to completion. The entry must keep the on-disk signal columns.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";
import type { ExecutionBackend, ExecutionBackendStartRequest } from "./execution-backend.js";

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-cancel-before-entry-"));
process.env.LAX_DATA_DIR = dataDir;

const { canonicalLoopEntry, registerAdapterForOp, resetCanonicalRuntime } = await import("./index.js");
const { _setExecutionBackendResolverForTest, resetScheduler } = await import("./scheduler.js");
const { opCancel } = await import("./control-api.js");
const { readOp, writeOp } = await import("../ops/op-store.js");

const adapter = { name: "cancel-before-entry", version: "1" } as Adapter;

class RecordingBackend implements ExecutionBackend {
  readonly id = "cancel-before-entry-test";
  readonly adapterProvisioning = "parent" as const;
  readonly settles: Array<() => void> = [];
  readonly starts = vi.fn((_request: ExecutionBackendStartRequest) => {
    const done = new Promise<void>((ok) => { this.settles.push(ok); });
    return { done };
  });

  place(op: Op) { return { targetId: `target-${op.id}`, disposition: "ready" as const }; }
  acceptsPlacement(): boolean { return true; }
  start(request: ExecutionBackendStartRequest): { done: Promise<void> } { return this.starts(request); }
  settleAll(): void { for (const ok of this.settles) ok(); }
}

function makeOp(label: string): Op {
  const task = `cancel before entry ${label}`;
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

let backend: RecordingBackend;

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

describe("canonicalLoopEntry keeps a cancel recorded before the op entered", () => {
  it("an op persisted then submitted with no Stop starts", async () => {
    backend = new RecordingBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const op = makeOp("runs");
    writeOp(op);
    registerAdapterForOp(op.id, () => adapter);
    canonicalLoopEntry(op);
    await vi.waitFor(() => expect(backend.starts).toHaveBeenCalledTimes(1));
  });

  it("a Stop between the caller's write and the entry cancels the op without a start", async () => {
    backend = new RecordingBackend();
    _setExecutionBackendResolverForTest(() => backend);
    const op = makeOp("stopped");
    writeOp(op);
    expect(opCancel(op.id, "user")).toEqual({ ok: true });
    expect(readOp(op.id)?.canonical?.cancelRequestedAt).toBeTruthy();

    registerAdapterForOp(op.id, () => adapter);
    canonicalLoopEntry(op);

    await vi.waitFor(() => expect(readOp(op.id)?.canonical?.state).toBe("cancelled"));
    expect(backend.starts).not.toHaveBeenCalled();
  });
});
