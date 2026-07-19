import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Adapter } from "../src/canonical-loop/adapter-contract.js";
import { createRuntimeReconstructionFailureAdapter } from "../src/canonical-loop/adapters/runtime-reconstruction-failure.js";
import { awaitIdle, enqueueOp, pumpScheduler, resetScheduler, schedulerSnapshot } from "../src/canonical-loop/scheduler.js";
import { registerAdapterForOp, resetCanonicalRuntime } from "../src/canonical-loop/runtime.js";
import { readOp, writeOp } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import { opCancel } from "../src/canonical-loop/control-api.js";

let dataDir: string;
let priorDataDir: string | undefined;
let sequence = 0;

function op(backoffMs: number[], maxRecoveryAttempts: number): Op {
  const id = `op_retry_policy_${sequence++}`;
  return {
    id,
    type: "freeform",
    task: "resume from the durable checkpoint",
    lane: "background",
    retryPolicy: { maxRecoveryAttempts, backoffMs },
    ownerId: "local-user",
    visibility: "private",
    status: "queued",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    model: "test-model",
    canonical: { state: "queued", flagValue: true, sessionId: `session-${id}` },
    contextPack: {
      task: { description: "resume", successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {},
      budget: { maxIterations: 2, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
      routing: { lane: "background" },
      secrets: { allowed: [] },
    },
  } as Op;
}

function successAdapter(): Adapter {
  return {
    name: "retry-test-success",
    version: "1",
    async runTurn() {
      return {
        providerState: { adapterName: "retry-test-success", adapterVersion: "1", providerPayload: null },
        terminalReason: "done",
      };
    },
    async abort() {},
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  priorDataDir = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "adapter-retry-"));
  process.env.LAX_DATA_DIR = dataDir;
  resetCanonicalRuntime();
  resetScheduler();
});

afterEach(() => {
  resetScheduler();
  resetCanonicalRuntime();
  if (priorDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = priorDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("canonical retryable adapter recovery", () => {
  it("backs off without holding the lane and then resumes successfully", async () => {
    const recovering = op([40], 2);
    const next = op([], 0);
    writeOp(recovering);
    writeOp(next);
    let attempts = 0;
    registerAdapterForOp(recovering.id, () => (
      attempts++ === 0 ? createRuntimeReconstructionFailureAdapter(true) : successAdapter()
    ));
    registerAdapterForOp(next.id, successAdapter);

    enqueueOp(recovering.id, "background");
    enqueueOp(next.id, "background");
    pumpScheduler();
    await awaitIdle();

    expect(attempts).toBe(2);
    expect(readOp(next.id)?.canonical?.state).toBe("succeeded");
    expect(readOp(recovering.id)).toMatchObject({
      attemptCount: 1,
      status: "completed",
      canonical: { state: "succeeded", retryNotBefore: null },
    });
    expect(Date.parse(readOp(next.id)!.completedAt!)).toBeLessThan(Date.parse(readOp(recovering.id)!.completedAt!));
  });

  it("preserves a queued retry across scheduler process-state loss", async () => {
    const recovering = op([150], 2);
    writeOp(recovering);
    registerAdapterForOp(recovering.id, () => createRuntimeReconstructionFailureAdapter(true));
    enqueueOp(recovering.id, "background");
    pumpScheduler();
    await waitFor(() => readOp(recovering.id)?.attemptCount === 1 && schedulerSnapshot().activeCount === 0);

    expect(readOp(recovering.id)?.canonical?.state).toBe("queued");
    expect(readOp(recovering.id)?.canonical?.retryNotBefore).toBeTruthy();
    resetScheduler();
    resetCanonicalRuntime();
    registerAdapterForOp(recovering.id, successAdapter);
    enqueueOp(recovering.id, "background");
    pumpScheduler();
    await awaitIdle();

    expect(readOp(recovering.id)?.canonical?.state).toBe("succeeded");
    expect(readOp(recovering.id)?.attemptCount).toBe(1);
  });

  it("fails closed after the persisted retry budget without serializing a secret", async () => {
    const exhausted = op([0], 1);
    exhausted.task = "do not persist marker-credential-987";
    writeOp(exhausted);
    registerAdapterForOp(exhausted.id, () => createRuntimeReconstructionFailureAdapter(true));
    enqueueOp(exhausted.id, "background");
    pumpScheduler();
    await awaitIdle();

    const persisted = readOp(exhausted.id)!;
    expect(persisted.canonical?.state).toBe("failed");
    expect(persisted.attemptCount).toBe(1);
    expect(persisted.lastFailureReason).toBe("adapter_retry_exhausted:runtime_reconstruction_unavailable");
    expect(JSON.stringify({ canonical: persisted.canonical, lastFailureReason: persisted.lastFailureReason }))
      .not.toContain("marker-credential-987");
  });

  it("wakes a queued backoff immediately to honor cancel", async () => {
    const recovering = op([60_000], 2);
    writeOp(recovering);
    registerAdapterForOp(recovering.id, () => createRuntimeReconstructionFailureAdapter(true));
    enqueueOp(recovering.id, "background");
    pumpScheduler();
    await waitFor(() => readOp(recovering.id)?.canonical?.state === "queued"
      && readOp(recovering.id)?.attemptCount === 1);

    expect(opCancel(recovering.id, "user")).toEqual({ ok: true });
    await awaitIdle();

    expect(readOp(recovering.id)?.canonical?.state).toBe("cancelled");
  });
});
