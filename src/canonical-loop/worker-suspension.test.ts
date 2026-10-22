/**
 * What a suspension does to an op (worker-suspension.ts). Seven Dream runs that
 * suspended between July and September were still listed as running workers on
 * 2026-10-22; nobody resumes Dream, so a suspension now ends it. Every other worker
 * keeps the resumable pause.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";

// op-store binds its base dir at import, so the override must land first.
const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-worker-suspension-"));
process.env.LAX_DATA_DIR = dataDir;

const { applySuspension } = await import("./worker-suspension.js");
const { REPEAT_FAILURE_REASON } = await import("./middlewares/repeat-failure.js");
const { writeOp } = await import("../ops/op-store.js");
const { OP_TYPE } = await import("../ops/op-types.js");
const { listLiveWorkers } = await import("./live-workers.js");
const { trackOpForSession } = await import("../ops/session-bridge.js");

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function runningOp(type: string): Op {
  const op: Op = {
    id: `op-susp-${++seq}-${process.hrtime.bigint().toString(36)}`,
    type,
    task: "suspension contract",
    model: "test-model",
    contextPack: {} as Op["contextPack"],
    lane: "background",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000, 30_000] },
    ownerId: "test",
    visibility: "private",
    status: "running",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    canonical: { flagValue: true, state: "running" },
  };
  writeOp(op);
  trackOpForSession(op.id, `dream-${seq}`);
  return op;
}

describe("applySuspension", () => {
  const message = "\n\nSuspended: remember remained blocked after 5 attempts.";

  it("ends a Dream run as failed, keeping why it stopped, and it is no longer a live worker", () => {
    const op = runningOp(OP_TYPE.memoryConsolidation);
    expect(applySuspension(op, REPEAT_FAILURE_REASON, message)).toBe("ended");
    expect(op.canonical?.state).toBe("failed");
    expect(op.canonical?.suspension).toMatchObject({ reason: "blocked", detail: message });
    expect(op.lastFailureReason).toBe(`suspended:${REPEAT_FAILURE_REASON}`);
    expect(listLiveWorkers().some((w) => w.opId === op.id)).toBe(false);
  });

  it("pauses any other worker so the user can fix the cause and resume it", () => {
    const op = runningOp(OP_TYPE.appBuilder);
    expect(applySuspension(op, "stalled", "no adapter reports for 600000ms — model presumed stuck")).toBe("paused");
    expect(op.canonical?.state).toBe("paused");
    expect(op.canonical?.suspension).toMatchObject({ reason: "stalled" });
    expect(listLiveWorkers().find((w) => w.opId === op.id)?.status).toBe("stalled");
  });
});
