/**
 * Issue 06 — opCancel (mid-stream, hard cancel).
 * docs/issues/canonical-loop/07-cancel-mid-stream.md (PRD §13)
 *
 * Acceptance covered:
 *   a) Happy path: mid-turn cancel — adapter.abort() invoked, state cancelled
 *      within 2s, partial turn discarded (no commit, no op_turns row).
 *   b) Pre-lease cancel: queued → cancelled with no running state ever entered.
 *   c) Idempotency: two opCancel calls in a row.
 *   d) Already-terminal: cancel a succeeded op → terminal error.
 *   e) Cancel beats pause.
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
  opCancel,
  opPause,
  subscribeOpStream,
  readCanonicalEvents,
  readOpTurn,
  readOpMessages,
  type CanonicalEvent,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/workers/op-store.js";
import type { Op } from "../src/workers/types.js";

import { FakeAdapter, scriptTurn, scriptLongStreamingTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

// ── Helpers ──────────────────────────────────────────────────────────────

function mkOp(label: string, lane: Op["lane"] = "interactive"): Op {
  return {
    id: track(newOpId(`it06_${label}`)),
    type: "freeform",
    task: `issue-06 ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-06",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitState(opId: string, target: "cancelled" | "succeeded" | "paused", timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = readOp(opId);
    if (op?.canonical?.state === target) return;
    if (Date.now() > deadline) {
      const events = readCanonicalEvents(opId).map(e => e.type).join(",");
      throw new Error(`awaitState(${target}) timed out for ${opId} — events=[${events}], state=${op?.canonical?.state}`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

function bodyOf<T = Record<string, unknown>>(e: CanonicalEvent): T {
  return (e.body ?? {}) as T;
}

function findStateChange(events: CanonicalEvent[], from: string | null, to: string): CanonicalEvent | undefined {
  return events.find(e => {
    if (e.type !== "state_changed") return false;
    const b = bodyOf<{ from: string | null; to: string }>(e);
    return b.from === from && b.to === to;
  });
}

// ── (a) Happy path: cancel mid-stream ────────────────────────────────────

describe("Issue 06 — happy path cancel mid-stream", () => {
  it("aborts the adapter, transitions to cancelled, discards the partial turn", async () => {
    const op = mkOp("happy");
    // Long-streaming turn that won't naturally finish in our test window.
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);

    // Wait for the first stream chunk to ride op_stream — that proves the
    // adapter is mid-stream when we cancel.
    const firstChunk = new Promise<void>((resolve) => {
      const off = subscribeOpStream(op.id, () => { off(); resolve(); });
    });

    canonicalLoopEntry(op);
    await firstChunk;

    const cancelTime = Date.now();
    const r = opCancel(op.id, "test-actor");
    expect(r.ok).toBe(true);

    await awaitState(op.id, "cancelled", 2_000);
    const elapsedMs = Date.now() - cancelTime;

    const events = readCanonicalEvents(op.id);

    // ── Strict event sequence (regression guard for the "stale op" pattern):
    // cancel_requested → state_changed running→cancelling →
    // state_changed cancelling→cancelled → lease_lost reason=cancelled.
    // If the worker reused a stale in-memory op object after the signal
    // handler transitioned running→cancelling, the cancelling→cancelled
    // transition would be rejected and the op would fall into `failed`.
    const cancelReq = events.find(e => e.type === "cancel_requested");
    const runningToCancelling = findStateChange(events, "running", "cancelling");
    const cancellingToCancelled = findStateChange(events, "cancelling", "cancelled");
    const leaseLost = events.find(e => e.type === "lease_lost");

    expect(cancelReq, "cancel_requested missing").toBeDefined();
    expect(runningToCancelling, "state_changed running→cancelling missing").toBeDefined();
    expect(cancellingToCancelled, "state_changed cancelling→cancelled missing").toBeDefined();
    expect(leaseLost, "lease_lost missing").toBeDefined();

    // Strict seq ordering across the four events.
    expect(cancelReq!.seq).toBeLessThan(runningToCancelling!.seq);
    expect(runningToCancelling!.seq).toBeLessThan(cancellingToCancelled!.seq);
    expect(cancellingToCancelled!.seq).toBeLessThan(leaseLost!.seq);

    // Reasons on the two state_changed bodies.
    expect(bodyOf<{ reason: string }>(runningToCancelling!).reason).toBe("cancel_requested");
    expect(bodyOf<{ reason: string }>(cancellingToCancelled!).reason).toBe("adapter_aborted");

    // The op MUST land at cancelled, NOT at failed (regression guard for
    // running→cancelled illegal-transition fallthrough).
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");
    expect(readOp(op.id)?.canonical?.state).not.toBe("failed");
    expect(events.some(e =>
      e.type === "state_changed" && bodyOf<{ to: string }>(e).to === "failed",
    )).toBe(false);

    // adapter.abort() was invoked, and the round-trip (cancel-call →
    // cancelled state) finished within the PRD §15 acceptance window
    // (1s for abort + scheduling slack).
    expect(adapter.abortCalls).toBeGreaterThanOrEqual(1);
    expect(elapsedMs, `cancel→cancelled took ${elapsedMs}ms`).toBeLessThan(1500);

    // lease_lost reason
    expect(bodyOf<{ reason: string }>(leaseLost!).reason).toBe("cancelled");

    // Partial turn discarded — no commit artifacts for the aborted turn.
    expect(events.some(e => e.type === "turn_committed")).toBe(false);
    expect(readOpTurn(op.id, 0)).toBeNull();
    expect(readOpMessages(op.id)).toEqual([]);

    // cancel_requested_at cleared on the terminal write.
    expect(readOp(op.id)?.canonical?.cancelRequestedAt).toBeNull();
  });
});

// ── (b) Pre-lease cancel ─────────────────────────────────────────────────

describe("Issue 06 — pre-lease cancel", () => {
  it("queued → cancelled directly; no running state ever entered", async () => {
    const op = mkOp("pre-lease");
    // Adapter that would normally drive the op — but we cancel before the
    // scheduler pumps the worker.
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "should never run", terminal: "done" })],
    }));

    canonicalLoopEntry(op);
    // Synchronous opCancel — between sync canonicalLoopEntry and the
    // microtask-scheduled worker launch.
    const r = opCancel(op.id, "pre-lease-actor");
    expect(r.ok).toBe(true);

    await awaitState(op.id, "cancelled", 2_000);

    const events = readCanonicalEvents(op.id);
    const transitions = events
      .filter(e => e.type === "state_changed")
      .map(e => `${bodyOf<{ from: string | null; to: string }>(e).from}→${bodyOf<{ from: string | null; to: string }>(e).to}`);
    expect(transitions).toEqual(["null→queued", "queued→cancelled"]);

    expect(events.some(e => e.type === "lease_acquired")).toBe(false);
    expect(events.some(e => e.type === "turn_started")).toBe(false);
    expect(events.some(e => e.type === "turn_committed")).toBe(false);

    const queuedToCancelled = findStateChange(events, "queued", "cancelled");
    expect(bodyOf<{ reason: string }>(queuedToCancelled!).reason).toBe("cancel_before_lease");
  });
});

// ── (c) Idempotency ──────────────────────────────────────────────────────

describe("Issue 06 — idempotent opCancel", () => {
  it("two cancel calls produce one cancel_requested event and one terminal transition", async () => {
    const op = mkOp("idem");
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);

    const firstChunk = new Promise<void>((resolve) => {
      const off = subscribeOpStream(op.id, () => { off(); resolve(); });
    });

    canonicalLoopEntry(op);
    await firstChunk;

    const r1 = opCancel(op.id, "first");
    const r2 = opCancel(op.id, "second");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    await awaitState(op.id, "cancelled");

    const events = readCanonicalEvents(op.id);
    const cancelRequested = events.filter(e => e.type === "cancel_requested");
    expect(cancelRequested).toHaveLength(1);

    const cancelledTransitions = events.filter(e => {
      if (e.type !== "state_changed") return false;
      return bodyOf<{ to: string }>(e).to === "cancelled";
    });
    expect(cancelledTransitions).toHaveLength(1);
  });
});

// ── (d) Already-terminal cancel ──────────────────────────────────────────

describe("Issue 06 — cancel on already-terminal op", () => {
  it("returns terminal error and writes no cancel_requested event", async () => {
    const op = mkOp("terminal");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "ok", terminal: "done" })],
    }));
    canonicalLoopEntry(op);
    await awaitState(op.id, "succeeded");
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

    const r = opCancel(op.id, "late-actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("terminal");

    const events = readCanonicalEvents(op.id);
    expect(events.some(e => e.type === "cancel_requested")).toBe(false);
  });
});

// ── (e) Cancel beats pause ───────────────────────────────────────────────

describe("Issue 06 — cancel beats pause (PRD §13 precedence)", () => {
  it("with both pause and cancel set mid-turn, op transitions to cancelled, never paused", async () => {
    const op = mkOp("cancel-beats-pause");
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);

    const firstChunk = new Promise<void>((resolve) => {
      const off = subscribeOpStream(op.id, () => { off(); resolve(); });
    });

    canonicalLoopEntry(op);
    await firstChunk;

    // Pause first, then cancel — both signals land while turn 0 streams.
    expect(opPause(op.id, "p").ok).toBe(true);
    expect(opCancel(op.id, "c").ok).toBe(true);

    await awaitState(op.id, "cancelled");

    const events = readCanonicalEvents(op.id);
    const transitionTos = events
      .filter(e => e.type === "state_changed")
      .map(e => bodyOf<{ to: string }>(e).to);
    expect(transitionTos).toContain("cancelled");
    expect(transitionTos).not.toContain("paused");
  });
});

// ── Sanity: error envelopes ──────────────────────────────────────────────

describe("Issue 06 — error envelope sanity", () => {
  it("returns unknown_op for an op id that doesn't exist", () => {
    const r = opCancel("op_does_not_exist_cancel", "actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown_op");
  });

  it("returns invalid_op_id for empty string", () => {
    const r = opCancel("", "actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_op_id");
  });
});
