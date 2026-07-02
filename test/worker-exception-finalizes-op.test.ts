/**
 * Regression — a worker-loop exception must FINALIZE the op (C3).
 *
 * The bug: worker.ts's drive() catch emitted a `worker_exception` error event
 * but performed NO terminal state transition, while the finally released the
 * lease. On disk the op was left `state === "running"` with `leaseOwner ===
 * null`. Boot recovery (recovery.ts) returns `no_lease` for exactly that shape
 * and skips it, so the op wedged in `running` forever — the chat event pump
 * waits on a terminal `state_changed` that never arrives and the spinner never
 * clears. Triggers include a disk-full throw inside commitTurn and the
 * fail-closed unresolvable-model throw in middlewares/host.ts.
 *
 * The fix mirrors the MAX_TURNS branch: on a caught loop exception, record the
 * terminal outcome and transition the op to `failed` (guarded so a
 * double/illegal transition can't itself throw back out of the catch).
 *
 * Real seam exercised: the worker drives a real turn; the model requests a
 * tool; the canonical tool-dispatcher THROWS. dispatchTools calls
 * `dispatcher.dispatch(call)` with no try/catch and sits OUTSIDE driveTurn's
 * inner adapter try/catch, so the throw propagates through driveTurn into the
 * worker's catch — the exact finalize path under test. No mock of the worker
 * or of drive() itself; the exception enters through a genuine cross-module
 * call chain.
 *
 * On OLD code the op stays `running` → this test fails (assert `failed`).
 * On the FIX the op ends `failed` with the lease released → passes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalLoopEntry,
  registerAdapterForOp,
  resetCanonicalRuntime,
  resetScheduler,
  awaitIdle,
  resetBus,
  setLeaseConfig,
  resetLeaseConfig,
  setToolDispatcher,
  readCanonicalEvents,
  recoverStaleOp,
  opCancel,
} from "../src/canonical-loop/index.js";
import { readOp, writeOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";

import { FakeAdapter, scriptTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  // Compress the lease cycle (same as the Issue-08 suite) so a hung/failed
  // worker doesn't hold real wall-clock leases.
  setLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 25 });
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  resetLeaseConfig();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

function mkOp(label: string): Op {
  return {
    id: track(newOpId(`wexc_${label}`)),
    type: "freeform",
    task: `worker-exception ${label}`,
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-worker-exception",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

/** Wait until the op reaches any terminal state OR the worker has drained. */
async function awaitWorkerDrained(opId: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = readOp(opId)?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return;
    if (Date.now() > deadline) return; // fall through — the assertions below report the real state
    await new Promise(r => setTimeout(r, 5));
  }
}

describe("worker loop exception finalizes the op (C3 regression)", () => {
  it("a throwing tool dispatcher drives the op to terminal `failed` and releases the lease", async () => {
    const op = mkOp("dispatch-throws");

    // Turn 0 requests a (non-silent) tool so the worker enters dispatchTools.
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ toolCalls: [{ toolCallId: "wexc-0", tool: "search", args: {} }] })],
    }));

    // The canonical tool-dispatcher throws — a real subsystem fault (not a
    // mock of the worker). dispatchTools has no try/catch around dispatch(),
    // so this propagates out of driveTurn into the worker's catch block.
    setToolDispatcher({
      async dispatch() {
        throw new Error("simulated tool-dispatch fault");
      },
    });

    canonicalLoopEntry(op);

    // Let the worker run its turn, hit the throw, and settle its finally.
    await awaitWorkerDrained(op.id);
    // awaitIdle blocks on the scheduler's active map, i.e. until drive()'s
    // finally (lease release) has run — the correct sync point for asserting
    // both the terminal state AND the released lease.
    await awaitIdle(3_000).catch(() => undefined);

    const after = readOp(op.id);

    // Core regression: the op must be TERMINAL `failed`, never left `running`
    // (the wedge) or `cancelling`.
    expect(after?.canonical?.state).toBe("failed");
    expect(after?.canonical?.state).not.toBe("running");
    expect(after?.canonical?.state).not.toBe("cancelling");

    // Lease released by the finally regardless of the fix.
    expect(after?.canonical?.leaseOwner ?? null).toBeNull();

    // The user-visible reason event is preserved (fix adds the transition, it
    // does not replace the emit).
    const events = readCanonicalEvents(op.id);
    const workerExc = events.find(e =>
      e.type === "error" &&
      (e.body as { code?: string } | undefined)?.code === "worker_exception",
    );
    expect(workerExc).toBeDefined();

    // And a terminal `state_changed` → failed exists so the chat pump can stop
    // waiting (the whole point — the spinner clears).
    const failedTransition = events.find(e =>
      e.type === "state_changed" &&
      (e.body as { to?: string } | undefined)?.to === "failed",
    );
    expect(failedTransition).toBeDefined();
  });

  it("a cancel that lands mid-turn before a tool throws finalizes the op to `cancelled`, never wedged in `cancelling` (Hole 1)", async () => {
    const op = mkOp("cancelling-throws");

    // Turn 0 requests a tool so the worker enters dispatchTools.
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ toolCalls: [{ toolCallId: "wexc-cancel-0", tool: "search", args: {} }] })],
    }));

    // Inside tool dispatch: a user Stop lands (opCancel publishes a cancel
    // signal on the bus; the worker's cancel-handler subscription synchronously
    // transitions running → cancelling). THEN a real tool fault throws. The
    // throw bypasses the worker's `if (tracker.cancelled)` finalize branch —
    // that branch only runs when driveTurn RETURNS, not when it THROWS — so it
    // lands in the worker catch with state === "cancelling". running → failed is
    // ILLEGAL there; pre-remediation it's swallowed and the op wedges
    // `cancelling` + no-lease. The fix finalizes via cancelling → cancelled.
    setToolDispatcher({
      async dispatch() {
        opCancel(op.id, "test-cancel-midturn");
        throw new Error("simulated tool-dispatch fault after cancel");
      },
    });

    canonicalLoopEntry(op);

    await awaitWorkerDrained(op.id);
    await awaitIdle(3_000).catch(() => undefined);

    const after = readOp(op.id);

    // TERMINAL `cancelled` — never stuck in `cancelling` (the Hole-1 wedge).
    expect(after?.canonical?.state).toBe("cancelled");
    expect(after?.canonical?.state).not.toBe("cancelling");
    expect(after?.canonical?.state).not.toBe("running");

    // Lease released by the finally.
    expect(after?.canonical?.leaseOwner ?? null).toBeNull();

    // A terminal `state_changed` → cancelled exists so the chat pump stops
    // waiting and the spinner clears.
    const events = readCanonicalEvents(op.id);
    const cancelledTransition = events.find(e =>
      e.type === "state_changed" &&
      (e.body as { to?: string } | undefined)?.to === "cancelled",
    );
    expect(cancelledTransition).toBeDefined();
  });
});

describe("recovery reclaims a non-terminal no-lease orphan (C3 Hole 2 class-fix)", () => {
  it("recoverStaleOp reclaims a `cancelling` op with no lease as `cancelled`, not skipped as `no_lease`", () => {
    // Construct the C3 orphan shape directly on disk: a non-terminal op whose
    // worker released its lease (the `finally`) but never landed a terminal
    // transition (disk-full during commitTurn; a cancel-time throw whose
    // cancelling → failed was swallowed as illegal). Pre-remediation recovery.ts
    // returns `no_lease` and SKIPS this shape, wedging the op forever.
    const op = mkOp("orphan-no-lease");
    op.status = "running";
    op.canonical = {
      state: "cancelling",
      flagValue: true,
      leaseOwner: null,
      leaseExpiresAt: null,
      currentTurnIdx: 0,
    };
    writeOp(op);

    const outcome = recoverStaleOp(op.id);

    // Recovery is the single chokepoint that closes the class: a non-terminal op
    // with NO live owner IS recoverable. Cancel always wins (PRD §13), so a
    // `cancelling` orphan finalizes cancelling → cancelled.
    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe("cancelled");
    expect(outcome.kind).not.toBe("no_lease");

    // The op is now TERMINAL on disk — the wedge is gone.
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");
  });
});
