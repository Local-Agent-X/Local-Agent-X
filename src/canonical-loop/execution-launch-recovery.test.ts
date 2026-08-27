/**
 * Rejected-execution-launch reconciliation contract.
 *
 * The seam only ever acts on `queued` ops — anything running or terminal
 * belongs to the canonical worker — so its `committingCallsAlreadyMade: false`
 * cannot cause a double-mutate: a re-queued op relaunches at the next
 * uncommitted turn index and replays nothing it already committed. These tests
 * pin the ownership guard, the bounded retry (including across committed
 * work), and the two terminal shapes.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { OpTurnRow } from "./types.js";

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-execution-launch-recovery-"));
process.env.LAX_DATA_DIR = dataDir;

const { recoverRejectedExecutionLaunch } = await import("./execution-launch-recovery.js");
const { insertOpTurn, readOpTurns } = await import("./store.js");
const { readOp, writeOp } = await import("../ops/op-store.js");
const { opCommittedWork } = await import("../committing-tool-check.js");

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
const uid = (label: string) => `op-${label}-${++seq}-${process.hrtime.bigint().toString(36)}`;

function writeOpInState(
  opId: string,
  state: "queued" | "running",
  attemptCount = 0,
): string {
  const op: Op = {
    id: opId,
    type: "freeform",
    task: "execution launch contract",
    model: "test-model",
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 2, backoffMs: [5_000, 30_000] },
    ownerId: "test",
    visibility: "private",
    status: state === "queued" ? "pending" : "running",
    createdAt: new Date().toISOString(),
    attemptCount,
    canonical: { flagValue: true, state },
  };
  writeOp(op);
  return opId;
}

function commitCommittingTurn(opId: string, turnIdx = 0): void {
  const row: OpTurnRow = {
    opId,
    turnIdx,
    providerState: { adapterName: "test", adapterVersion: "1", providerPayload: null },
    toolCallSummary: [
      { tool: "secret_save", argsHash: "h", resultStatus: "ok", durationMs: 3 },
    ],
    terminalReason: null,
    redirectConsumed: false,
    createdAt: new Date().toISOString(),
  };
  expect(insertOpTurn(row)).toBe(true);
}

describe("recoverRejectedExecutionLaunch", () => {
  it("leaves a running op to its worker", () => {
    const opId = writeOpInState(uid("running"), "running");

    expect(recoverRejectedExecutionLaunch(opId)).toEqual({ kind: "owned" });
    expect(readOp(opId)?.attemptCount).toBe(0);
  });

  it("reports an unknown op as owned rather than inventing a retry", () => {
    expect(recoverRejectedExecutionLaunch(uid("missing"))).toEqual({ kind: "owned" });
  });

  it("retries a queued op that already committed a side-effecting tool", () => {
    const opId = writeOpInState(uid("committed"), "queued");
    commitCommittingTurn(opId);
    // Guard the fixture: without this the assertion below could pass vacuously.
    expect(opCommittedWork(readOpTurns(opId))).toBe(true);

    expect(recoverRejectedExecutionLaunch(opId)).toEqual({ kind: "retry", delayMs: 5_000 });
    expect(readOp(opId)?.canonical?.state).toBe("queued");
    expect(readOp(opId)?.attemptCount).toBe(1);
    expect(readOp(opId)?.lastFailureReason).toBe("execution_launch_retry");
  });

  it("stops at the retry-policy attempt cap", () => {
    const opId = writeOpInState(uid("exhausted"), "queued", 2);

    expect(recoverRejectedExecutionLaunch(opId)).toEqual({ kind: "terminal" });
    expect(readOp(opId)?.canonical?.state).toBe("failed");
    expect(readOp(opId)?.lastFailureReason).toBe("execution_launch_exhausted");
  });

  it("fails a factory rejection terminally without consuming a retry", () => {
    const opId = writeOpInState(uid("factory"), "queued");

    expect(recoverRejectedExecutionLaunch(opId, false)).toEqual({ kind: "terminal" });
    expect(readOp(opId)?.canonical?.state).toBe("failed");
    expect(readOp(opId)?.lastFailureReason).toBe("adapter_factory_failed");
    expect(readOp(opId)?.attemptCount).toBe(0);
  });
});
