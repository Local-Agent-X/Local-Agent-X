import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Op } from "../ops/types.js";

const scheduler = vi.hoisted(() => ({ enqueueOp: vi.fn(), pumpScheduler: vi.fn(), evictWorker: vi.fn() }));
vi.mock("./scheduler.js", () => scheduler);

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-container-recovery-"));
process.env.LAX_DATA_DIR = dataDir;
const { writeOp } = await import("../ops/op-store.js");
const { claimProcessExecution } = await import("./process-execution-claim.js");
const { recoverStaleOp } = await import("./recovery.js");

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("container recovery routing", () => {
  it("re-enqueues the exact recorded backend instead of ambient Docker inspection", () => {
    const op = fixtureOp();
    writeOp(op);
    expect(claimProcessExecution({ schemaVersion: 1, opId: op.id,
      backendId: "local-container", targetId: "container-target", placementRevision: 7,
      token: "token", pid: 17, processStartedAt: op.createdAt, heartbeatAt: op.createdAt,
      ownerKind: "container", containerId: "c".repeat(64), containerCreatedAt: op.createdAt,
      imageDigest: `sha256:${"a".repeat(64)}` })).toBe(true);

    expect(recoverStaleOp(op.id)).toMatchObject({ ok: true, kind: "recovered" });
    expect(scheduler.enqueueOp).toHaveBeenCalledWith(op.id, "background");
    expect(scheduler.pumpScheduler).toHaveBeenCalledOnce();
  });
});

function fixtureOp(): Op {
  const createdAt = "2026-07-21T12:00:00.000Z";
  return { id: "op-container-recovery", type: "delegated_task", task: "resume",
    lane: "background", ownerId: "owner", visibility: "private", status: "running",
    createdAt, startedAt: createdAt, attemptCount: 0, model: "test",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    contextPack: { task: { description: "resume", successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" }, capabilities: {},
      budget: { maxIterations: 2, maxTokens: 100, maxWallTimeMs: 10_000, maxSelfEditCalls: 0 },
      routing: { lane: "background" }, secrets: { allowed: [] } },
    canonical: { flagValue: true, state: "running", sessionId: "session-container-recovery",
      leaseOwner: "dead-parent", leaseExpiresAt: "2026-07-21T12:01:00.000Z",
      executionPlacement: { schemaVersion: 1, backendId: "local-container", targetId: "container-target",
        disposition: "ready", wakeToken: null, wakeRequestedAt: null, revision: 7 } },
  } as Op;
}
