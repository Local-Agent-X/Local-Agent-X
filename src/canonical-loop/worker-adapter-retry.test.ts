/**
 * Adapter-retry recovery contract.
 *
 * `handleAdapterRetry` passes `committingCallsAlreadyMade: false` to
 * decideRecovery. That is load-bearing, not an oversight: driveTurn only
 * reports a retryCode for a turn that dispatched nothing, and the relaunch
 * resumes at the next uncommitted turn index — so an op that already committed
 * a side-effecting tool in an EARLIER turn must still get its bounded retry
 * when a later turn dies on a transient provider error. These tests pin both
 * halves: committed work does NOT suppress the retry, and the attempt cap
 * still ends it.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { OpTurnRow } from "./types.js";

// The real failover runs underneath; one test below hands it a switch, since a
// genuine one needs a second credentialed provider on the box.
const failoverMock = vi.hoisted(() => ({ attempt: vi.fn() }));
vi.mock("./runtime-failover.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./runtime-failover.js")>();
  failoverMock.attempt.mockImplementation(real.attemptRuntimeFailover);
  return { ...real, attemptRuntimeFailover: failoverMock.attempt };
});

// op-store binds its base dir at import, so the override must land first.
const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-worker-adapter-retry-"));
process.env.LAX_DATA_DIR = dataDir;

const { handleAdapterRetry } = await import("./worker-adapter-retry.js");
const { insertOpTurn, readOpTurns, readCanonicalEvents } = await import("./store.js");
const { readOp, writeOp } = await import("../ops/op-store.js");
const { opCommittedWork } = await import("../committing-tool-check.js");
const { trackOpForSession, setSessionBroadcaster } = await import("../ops/session-bridge.js");

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
const uid = (label: string) => `op-${label}-${++seq}-${process.hrtime.bigint().toString(36)}`;

/** A running op mid-way through its turn loop. `interactive` keeps
 *  attemptRuntimeFailover ineligible so the decideRecovery seam is what the
 *  test actually exercises. */
function writeRunningOp(opId: string, attemptCount = 0): Op {
  const op: Op = {
    id: opId,
    type: "freeform",
    task: "adapter retry contract",
    model: "test-model",
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000, 30_000] },
    ownerId: "test",
    visibility: "private",
    status: "running",
    createdAt: new Date().toISOString(),
    attemptCount,
    canonical: { flagValue: true, state: "running" },
  };
  writeOp(op);
  return op;
}

/** Commit a turn whose tool call is unambiguously committing: email_send's
 *  row is external-comms, a committing tier with no arg-dependent reading. */
function commitCommittingTurn(opId: string, turnIdx = 0): void {
  const row: OpTurnRow = {
    opId,
    turnIdx,
    providerState: { adapterName: "test", adapterVersion: "1", providerPayload: null },
    toolCallSummary: [
      { tool: "email_send", argsHash: "h", resultStatus: "ok", durationMs: 3 },
    ],
    terminalReason: null,
    redirectConsumed: false,
    createdAt: new Date().toISOString(),
  };
  expect(insertOpTurn(row)).toBe(true);
}

describe("handleAdapterRetry recovery gating", () => {
  it("still retries after an earlier turn committed a side-effecting tool", async () => {
    const opId = uid("committed");
    const op = writeRunningOp(opId);
    commitCommittingTurn(opId);
    // Guard the fixture: without this the assertion below could pass vacuously.
    expect(opCommittedWork(readOpTurns(opId))).toBe(true);

    const outcome = await handleAdapterRetry(op, "rate_limit", "429 rate limit exceeded");

    expect(outcome).toBe("retrying");
    expect(readOp(opId)?.canonical?.state).toBe("queued");
    expect(readOp(opId)?.attemptCount).toBe(1);
    expect(readOp(opId)?.lastFailureReason).toBe("adapter_retry:rate_limit");
  });

  it("retries an op that committed nothing", async () => {
    const opId = uid("clean");
    const op = writeRunningOp(opId);
    expect(opCommittedWork(readOpTurns(opId))).toBe(false);

    const outcome = await handleAdapterRetry(op, "server_error", "502 bad gateway");

    expect(outcome).toBe("retrying");
    expect(readOp(opId)?.canonical?.state).toBe("queued");
    expect(readOp(opId)?.attemptCount).toBe(1);
  });

  it("stops at the retry-policy attempt cap even with no committed work", async () => {
    const opId = uid("exhausted");
    const op = writeRunningOp(opId, 3);
    expect(opCommittedWork(readOpTurns(opId))).toBe(false);

    const outcome = await handleAdapterRetry(op, "server_error", "502 bad gateway");

    expect(outcome).toBe("exhausted");
    expect(readOp(opId)?.canonical?.state).toBe("failed");
    expect(readOp(opId)?.lastFailureReason).toBe("adapter_retry_exhausted:server_error");
  });
});

// The owner's rule: no silent fallback. A switch to another provider (the
// allowRuntimeFailover opt-in) is announced where the run's other notices go —
// a progress line of that run in its session's activity feed, which the
// session-bridge observer draws from the op's own canonical `error` event.
describe("a runtime failover says so", () => {
  it("names the provider and model the run moved to, as a line in the run's activity feed", async () => {
    const opId = uid("failover");
    const op = writeRunningOp(opId);
    trackOpForSession(opId, `sess-${opId}`, "adapter retry contract");
    const broadcast = vi.fn();
    setSessionBroadcaster(broadcast);
    failoverMock.attempt.mockResolvedValueOnce({ kind: "switched", delayMs: 5_000, targetIdentity: "openai:gpt-5", provider: "openai", model: "gpt-5" });

    expect(await handleAdapterRetry(op, "rate_limit", "429 rate limit exceeded")).toBe("retrying");

    const announced = readCanonicalEvents(opId).find((e) => e.type === "error" && (e.body as { code?: string } | null)?.code === "runtime_failover");
    expect((announced?.body as { message: string }).message).toContain("openai/gpt-5");
    const lines = broadcast.mock.calls
      .map(([, ev]) => ev as { type: string; opId?: string; line?: string })
      .filter((ev) => ev.type === "bg_op_progress" && ev.opId === opId)
      .map((ev) => ev.line ?? "");
    expect(lines.some((line) => line.includes("runtime_failover") && line.includes("openai/gpt-5"))).toBe(true);
    expect(readOp(opId)?.canonical?.state).toBe("queued");
  });
});
