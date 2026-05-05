/**
 * Issue 11 — permanent invariants (PRD §22 / §10).
 * docs/issues/canonical-loop/11-v1-hardening-and-invariants.md
 *
 * The invariant set that MUST hold after every canonical-loop test for
 * the lifetime of the project (PRD acceptance: "After every test:
 * `ops.state == latest state_changed.to`."). Each invariant is enforced
 * here against ops produced by every terminal scenario the loop
 * supports — succeeded, failed, cancelled, paused-then-resumed.
 *
 * Invariants:
 *   I1. `op.canonical.state` equals the `to` field of the latest
 *       `state_changed` event in `op_events`.
 *   I2. `op.canonical.currentTurnIdx` equals MAX(`op_turns.turnIdx`)
 *       when at least one turn has committed (null/undefined if the
 *       op terminated before the first turn — e.g., pre-lease cancel).
 *   I3. `op_events` has per-op monotonic seq 0..N with no gaps and no
 *       duplicate seqs.
 *   I4. `op_turns` has monotonic turn_idx 0..M with no gaps.
 *   I5. Exactly one terminal `state_changed` event per op
 *       (`succeeded`, `failed`, or `cancelled`) — no duplicate
 *       terminal notifications.
 *   I6. After the terminal transition, `lease_owner` and
 *       `lease_expires_at` on the op are null.
 *
 * The helpers exported here (`assertCanonicalInvariants`) are reusable
 * by other tests; this file exercises them across a representative
 * matrix of ops.
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
  opCancel,
  opPause,
  opResume,
  readCanonicalEvents,
  readLatestOpTurn,
  readOpTurn,
  type CanonicalEvent,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/workers/op-store.js";
import type { Op } from "../src/workers/types.js";

import { FakeAdapter, scriptTurn, scriptMultiTurn, scriptLongStreamingTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 200, heartbeatIntervalMs: 50 });
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

function mkOp(label: string, lane: Op["lane"] = "interactive"): Op {
  return {
    id: track(newOpId(`it11i_${label}`)),
    type: "freeform",
    task: `issue-11 invariants ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-11-invariants",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitTerminal(opId: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = readOp(opId);
    const s = op?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return;
    if (Date.now() > deadline) {
      throw new Error(`awaitTerminal timed out for ${opId} — state=${s}`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

async function awaitState(opId: string, target: "paused" | "succeeded", timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = readOp(opId);
    if (op?.canonical?.state === target) return;
    if (Date.now() > deadline) {
      throw new Error(`awaitState(${target}) timed out for ${opId}`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Reusable invariant checker. Tests that drive an op to terminal can
 * call this to assert every Issue 11 invariant in one shot.
 */
export function assertCanonicalInvariants(opId: string): void {
  const op = readOp(opId);
  expect(op, `op ${opId} not on disk`).toBeTruthy();
  const events = readCanonicalEvents(opId);
  expect(events.length, `op ${opId} has zero canonical events`).toBeGreaterThan(0);

  // I3: per-op seq monotonic 0..N, no gaps, no dupes, no cross-op leaks.
  const seqs = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    expect(events[i].seq, `op=${opId} seq[${i}] out of order`).toBe(i);
    expect(events[i].opId, `op=${opId} cross-op event leak at seq=${events[i].seq}`).toBe(opId);
    expect(seqs.has(events[i].seq), `op=${opId} duplicate seq ${events[i].seq}`).toBe(false);
    seqs.add(events[i].seq);
  }

  // I1: ops.state == latest state_changed.to.
  const stateChanges = events.filter(e => e.type === "state_changed");
  if (stateChanges.length > 0) {
    const latest = stateChanges[stateChanges.length - 1];
    const to = (latest.body as { to?: string })?.to;
    expect(op?.canonical?.state, `op=${opId} state ${op?.canonical?.state} != latest state_changed.to ${to}`).toBe(to);
  }

  // I2: currentTurnIdx == MAX(op_turns.turnIdx) when any turn committed.
  const latestTurn = readLatestOpTurn(opId);
  if (latestTurn) {
    expect(op?.canonical?.currentTurnIdx, `op=${opId} currentTurnIdx ${op?.canonical?.currentTurnIdx} != MAX(op_turns.turnIdx) ${latestTurn.turnIdx}`)
      .toBe(latestTurn.turnIdx);
    // I4: op_turns turn_idx monotonic 0..M no gaps.
    for (let i = 0; i <= latestTurn.turnIdx; i++) {
      const row = readOpTurn(opId, i);
      expect(row, `op=${opId} missing op_turn row ${i}`).toBeTruthy();
      expect(row?.turnIdx, `op=${opId} turn_idx mismatch at ${i}`).toBe(i);
    }
  } else {
    // Pre-lease terminals: currentTurnIdx is null (set at canonicalLoopEntry).
    expect(op?.canonical?.currentTurnIdx ?? null).toBeNull();
  }

  // I5: at most one terminal state_changed.
  const terminalChanges = stateChanges.filter(e => {
    const to = (e.body as { to?: string })?.to;
    return to && TERMINAL_STATES.has(to);
  });
  if (op?.canonical?.state && TERMINAL_STATES.has(op.canonical.state)) {
    expect(terminalChanges).toHaveLength(1);
    expect((terminalChanges[0].body as { to: string }).to).toBe(op.canonical.state);
  }

  // I6: terminal ops have no live lease.
  if (op?.canonical?.state && TERMINAL_STATES.has(op.canonical.state)) {
    expect(op.canonical.leaseOwner ?? null, `op=${opId} terminal but lease still owned`).toBeNull();
    expect(op.canonical.leaseExpiresAt ?? null, `op=${opId} terminal but leaseExpiresAt set`).toBeNull();
  }
}

// ── Per-scenario invariant exercise ─────────────────────────────────────

describe("Issue 11 — invariants on the succeeded happy-path op", () => {
  it("succeeded op satisfies I1–I6", async () => {
    const op = mkOp("happy");
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["a", "b"], text: "turn 0" },
        { text: "turn 1", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    assertCanonicalInvariants(op.id);
  });
});

describe("Issue 11 — invariants on the failed op", () => {
  it("failed op satisfies I1–I6 (terminal=error, no live lease)", async () => {
    const op = mkOp("failed");
    const adapter = new FakeAdapter({
      script: [scriptTurn({ errorReports: [{ code: "synthetic", message: "synth", retryable: false }], terminal: "error" })],
    });
    registerAdapterForOp(op.id, () => adapter);
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("failed");
    assertCanonicalInvariants(op.id);
  });
});

describe("Issue 11 — invariants on the cancelled (mid-stream) op", () => {
  it("cancelled mid-stream op satisfies I1–I6 (no op_turns row, lease cleared)", async () => {
    const op = mkOp("cancelled");
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);
    canonicalLoopEntry(op);

    // Wait for first stream chunk before cancel.
    await new Promise(r => setTimeout(r, 50));
    expect(opCancel(op.id, "test-actor").ok).toBe(true);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");
    // I2 special case: no op_turns committed → currentTurnIdx stays null.
    assertCanonicalInvariants(op.id);
    expect(readLatestOpTurn(op.id)).toBeNull();
  });
});

describe("Issue 11 — invariants on the pre-lease cancelled op", () => {
  it("queued → cancelled (no running, no op_turns) satisfies I1–I6", async () => {
    const op = mkOp("pre-lease-cancel");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "should never run", terminal: "done" })],
    }));
    canonicalLoopEntry(op);
    expect(opCancel(op.id, "early").ok).toBe(true);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");
    assertCanonicalInvariants(op.id);
    expect(readCanonicalEvents(op.id).some(e => e.type === "lease_acquired")).toBe(false);
  });
});

describe("Issue 11 — invariants survive pause→resume→succeeded", () => {
  it("paused-then-resumed op ends succeeded with monotonic seq AND no orphan state_changed", async () => {
    const op = mkOp("pause-resume");
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["x"], text: "turn 0" },
        { text: "turn 1", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    // Pause as soon as the first turn starts streaming.
    let paused = false;
    const off = (await import("../src/canonical-loop/index.js")).subscribeOpEvents(op.id, e => {
      if (e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 0 && !paused) {
        paused = true;
        opPause(op.id, "for-resume");
      }
    });
    canonicalLoopEntry(op);
    await awaitState(op.id, "paused");
    off();

    expect(opResume(op.id, "resumer").ok).toBe(true);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    assertCanonicalInvariants(op.id);

    // Issue 11 specific: state_changed sequence is queued → running →
    // paused → queued → running → succeeded; assert that EXACTLY one
    // terminal change happened.
    const states = readCanonicalEvents(op.id)
      .filter(e => e.type === "state_changed")
      .map(e => (e.body as { to: string }).to);
    expect(states[states.length - 1]).toBe("succeeded");
    expect(states.filter(s => s === "succeeded")).toHaveLength(1);
  });
});

// ── Cross-event-stream uniqueness ──────────────────────────────────────

describe("Issue 11 — terminal event is emitted exactly once per op", () => {
  it("succeeded op emits exactly one running→succeeded state_changed AND one lease_lost", async () => {
    const op = mkOp("once-only");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "ok", terminal: "done" })],
    }));
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    const events = readCanonicalEvents(op.id);
    const succeeded = events.filter(e =>
      e.type === "state_changed" && (e.body as { to: string }).to === "succeeded",
    );
    expect(succeeded).toHaveLength(1);
    expect(events.filter(e => e.type === "lease_lost")).toHaveLength(1);
  });
});
