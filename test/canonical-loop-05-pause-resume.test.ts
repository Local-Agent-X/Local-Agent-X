/**
 * Issue 05 — Pause + resume on canonical-loop.
 * docs/issues/canonical-loop/05-pause-and-resume.md
 *
 * Acceptance covered:
 *   - opPause writes pause_requested_at, emits pause_requested with monotonic seq.
 *   - Pause applied at turn boundary: 2-turn FakeAdapter, pause requested
 *     during turn 0 is applied after commit; turn 1 never runs; lease
 *     released; pause_requested_at cleared.
 *   - opPause on terminal op → terminal error.
 *   - opPause on already-paused op → idempotent {ok:true}, no double event.
 *   - opPause on unknown op → unknown_op.
 *   - opResume on paused op transitions paused → queued → running →
 *     succeeded; emits resume_requested + state_changed.
 *   - opResume on non-paused op → not_paused.
 *   - Adapter on resume receives prior provider_state from last op_turns row.
 *   - Concurrent ops: pausing op A does not affect op B's seq stream.
 *   - Flag OFF: legacy submit path is unaffected; opPause returns unknown_op
 *     for ops that never went through canonical-loop.
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
  opPause,
  opResume,
  subscribeOpEvents,
  subscribeOpSignals,
  readCanonicalEvents,
  type CanonicalEvent,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/workers/op-store.js";
import type { Op } from "../src/workers/types.js";

import { FakeAdapter, scriptTurn, scriptMultiTurn } from "./canonical-loop/fake-adapter.js";

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
    id: track(newOpId(`it05_${label}`)),
    type: "freeform",
    task: `issue-05 ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-05",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitState(opId: string, target: "paused" | "succeeded" | "queued", timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = readOp(opId);
    if (op?.canonical?.state === target) return;
    if (Date.now() > deadline) {
      const events = readCanonicalEvents(opId).map(e => e.type);
      throw new Error(`awaitState(${target}) timed out for ${opId} — events=[${events.join(",")}], state=${op?.canonical?.state}`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
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

function assertMonotonic(events: CanonicalEvent[]): void {
  for (let i = 0; i < events.length; i++) {
    expect(events[i].seq, `seq mismatch at index ${i}`).toBe(i);
  }
}

// ── opPause: signal write + event emission ───────────────────────────────

describe("opPause — public API surface", () => {
  it("sets pause_requested_at and emits pause_requested with monotonic seq", () => {
    const op = mkOp("signal-write");
    canonicalLoopEntry(op); // no adapter — op stays queued for this sub-microtask window

    const before = readCanonicalEvents(op.id);
    expect(before).toHaveLength(1); // state_changed queued (seq=0)

    const r = opPause(op.id, "test-actor");
    expect(r.ok).toBe(true);

    const persisted = readOp(op.id);
    expect(persisted?.canonical?.pauseRequestedAt).toBeTruthy();

    const after = readCanonicalEvents(op.id);
    const newEvent = after.find(e => e.type === "pause_requested");
    expect(newEvent).toBeDefined();
    expect(newEvent!.seq).toBeGreaterThan(0);
    expect((newEvent!.body as { actor: string }).actor).toBe("test-actor");
    // Monotonic invariant holds across the new event.
    assertMonotonic(after);
  });

  it("publishes a fast-path pause signal on op_signals:{opId}", () => {
    const op = mkOp("signal-bus");
    canonicalLoopEntry(op);

    const received: Array<{ kind: string; opId: string }> = [];
    const off = subscribeOpSignals(op.id, s => received.push({ kind: s.kind, opId: s.opId }));
    opPause(op.id, "tester");
    off();

    expect(received).toEqual([{ kind: "pause", opId: op.id }]);
  });

  it("returns unknown_op for an op that never went through canonical-loop", () => {
    const r = opPause("op_does_not_exist_pause", "actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown_op");
  });

  it("returns invalid_op_id for empty string", () => {
    const r = opPause("", "actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_op_id");
  });
});

// ── Pause applied at turn boundary (acceptance test #3) ──────────────────

describe("pause applied at next turn boundary", () => {
  it("running→paused after current turn commits; turn 1 never runs", async () => {
    const op = mkOp("turn-boundary");
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["a", "b", "c"], text: "turn 0 result" },
        { text: "turn 1 should never run", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    // Subscribe to events; on turn_started for turn 0, request a pause.
    // The adapter has stream chunks with 5ms delays so the window is wide
    // enough for the synchronous opPause writeOp to land before turn 0
    // commits and the worker reaches its turn-boundary check.
    let paused = false;
    const off = subscribeOpEvents(op.id, e => {
      if (e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 0 && !paused) {
        paused = true;
        opPause(op.id, "boundary-test");
      }
    });

    canonicalLoopEntry(op);
    await awaitState(op.id, "paused");
    off();

    // State path: queued → running → paused. No second running.
    const events = readCanonicalEvents(op.id);
    assertMonotonic(events);

    const transitions = events
      .filter(e => e.type === "state_changed")
      .map(e => `${(e.body as { from: string | null; to: string }).from}→${(e.body as { from: string | null; to: string }).to}`);
    expect(transitions).toEqual(["null→queued", "queued→running", "running→paused"]);

    // Only turn 0 ran — no turn_started or turn_committed for turn 1.
    const turnStarts = events.filter(e => e.type === "turn_started").map(e => (e.body as { turnIdx: number }).turnIdx);
    const turnCommits = events.filter(e => e.type === "turn_committed").map(e => (e.body as { turnIdx: number }).turnIdx);
    expect(turnStarts).toEqual([0]);
    expect(turnCommits).toEqual([0]);

    // pause_requested_at cleared after applying.
    const persisted = readOp(op.id);
    expect(persisted?.canonical?.pauseRequestedAt).toBeNull();

    // Lease released.
    expect(persisted?.canonical?.leaseOwner).toBeNull();
    expect(persisted?.canonical?.leaseExpiresAt).toBeNull();

    // FakeAdapter only saw turn 0.
    expect(adapter.turnInputs.length).toBe(1);
    expect(adapter.turnInputs[0].turnIdx).toBe(0);
  });
});

// ── Idempotency + error codes ────────────────────────────────────────────

describe("opPause — error codes and idempotency", () => {
  it("returns terminal for ops in succeeded/failed/cancelled", async () => {
    // Drive a normal op to succeeded.
    const op = mkOp("paused-after-terminal");
    registerAdapterForOp(op.id, () => new FakeAdapter({ script: [scriptTurn({ text: "ok", terminal: "done" })] }));
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

    const r = opPause(op.id, "late-actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("terminal");
  });

  it("is idempotent on already-paused op (no double pause_requested event)", async () => {
    const op = mkOp("already-paused");
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["x"], text: "t0" },
        { text: "t1", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    const off = subscribeOpEvents(op.id, e => {
      if (e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 0) {
        opPause(op.id, "first");
      }
    });

    canonicalLoopEntry(op);
    await awaitState(op.id, "paused");
    off();

    const before = readCanonicalEvents(op.id).filter(e => e.type === "pause_requested").length;
    expect(before).toBe(1);

    // Second opPause — already paused, must be idempotent and not emit again.
    const r = opPause(op.id, "second");
    expect(r.ok).toBe(true);
    const after = readCanonicalEvents(op.id).filter(e => e.type === "pause_requested").length;
    expect(after).toBe(1); // unchanged
  });

  it("is idempotent on running op when pause is already pending", () => {
    const op = mkOp("pause-pending");
    canonicalLoopEntry(op);

    const r1 = opPause(op.id, "first");
    expect(r1.ok).toBe(true);
    const r2 = opPause(op.id, "second-redundant");
    expect(r2.ok).toBe(true);

    const events = readCanonicalEvents(op.id).filter(e => e.type === "pause_requested");
    expect(events).toHaveLength(1);
  });
});

// ── opResume ─────────────────────────────────────────────────────────────

describe("opResume — public API surface", () => {
  it("paused→queued; emits resume_requested + state_changed; op completes succeeded", async () => {
    const op = mkOp("resume-happy");
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["a"], text: "turn 0" },
        { text: "turn 1 after resume", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    const off = subscribeOpEvents(op.id, e => {
      if (e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 0) {
        opPause(op.id, "pre-resume-test");
      }
    });
    canonicalLoopEntry(op);
    await awaitState(op.id, "paused");
    off();

    // Resume.
    const r = opResume(op.id, "resumer");
    expect(r.ok).toBe(true);

    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

    // Event order: ... pause_requested → state_changed running→paused
    //              → resume_requested → state_changed paused→queued
    //              → lease_acquired → state_changed queued→running
    //              → turn_started 1 → ... → state_changed running→succeeded
    const events = readCanonicalEvents(op.id);
    assertMonotonic(events);

    const idxOf = (type: string, n = 0): number => {
      let count = 0;
      for (let i = 0; i < events.length; i++) {
        if (events[i].type === type) {
          if (count === n) return i;
          count++;
        }
      }
      return -1;
    };
    expect(idxOf("resume_requested")).toBeGreaterThan(idxOf("pause_requested"));
    // resume_requested precedes the paused→queued state_changed.
    const stateChanges = events.filter(e => e.type === "state_changed");
    const pausedToQueued = stateChanges.find(e => {
      const b = e.body as { from: string; to: string };
      return b.from === "paused" && b.to === "queued";
    });
    expect(pausedToQueued).toBeDefined();
    expect(pausedToQueued!.seq).toBeGreaterThan(events[idxOf("resume_requested")].seq);
  });

  it("returns not_paused for ops that are not paused", async () => {
    const op = mkOp("resume-not-paused");
    canonicalLoopEntry(op);
    // queued (no adapter; will fail on microtask).
    const r = opResume(op.id, "actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_paused");
  });

  it("returns unknown_op for an op that never went through canonical-loop", () => {
    const r = opResume("op_does_not_exist_resume", "actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown_op");
  });
});

// ── Adapter on resume receives prior provider_state ──────────────────────

describe("resume hands prior provider_state to the adapter", () => {
  it("adapter.turnInputs[1].providerState carries the envelope from turn 0", async () => {
    const op = mkOp("resume-provider-state");
    // Same adapter instance across pause+resume so we can inspect both turn inputs.
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        {
          streamChunks: ["chunk"],
          text: "first",
          providerStatePayload: { marker: "from-turn-0", n: 42 },
        },
        { text: "second", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    const off = subscribeOpEvents(op.id, e => {
      if (e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 0) {
        opPause(op.id, "for-resume");
      }
    });
    canonicalLoopEntry(op);
    await awaitState(op.id, "paused");
    off();

    expect(opResume(op.id, "resumer").ok).toBe(true);
    await awaitTerminal(op.id);

    expect(adapter.turnInputs.length).toBe(2);
    // Turn 0 was a cold start.
    expect(adapter.turnInputs[0].turnIdx).toBe(0);
    expect(adapter.turnInputs[0].providerState).toBeUndefined();
    // Turn 1 (post-resume) received the envelope checkpointed at turn 0.
    expect(adapter.turnInputs[1].turnIdx).toBe(1);
    const ps = adapter.turnInputs[1].providerState;
    expect(ps).toBeDefined();
    expect(ps!.adapterName).toBe("fake");
    expect(ps!.providerPayload).toMatchObject({ marker: "from-turn-0", n: 42 });
  });
});

// ── Concurrent ops keep seq spaces independent ───────────────────────────

describe("concurrent ops: pausing A does not disturb B", () => {
  it("op A is paused; op B completes succeeded with monotonic seq independent of A", async () => {
    const opA = mkOp("concurrent-a");
    const opB = mkOp("concurrent-b");

    const adapterA = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["a1"], text: "A turn 0" },
        { text: "A turn 1 should not run", terminal: "done" },
      ]),
    });
    const adapterB = new FakeAdapter({
      script: [scriptTurn({ text: "B done", terminal: "done" })],
    });
    registerAdapterForOp(opA.id, () => adapterA);
    registerAdapterForOp(opB.id, () => adapterB);

    const off = subscribeOpEvents(opA.id, e => {
      if (e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 0) {
        opPause(opA.id, "pause-a");
      }
    });

    canonicalLoopEntry(opA);
    canonicalLoopEntry(opB);

    await awaitState(opA.id, "paused");
    await awaitTerminal(opB.id);
    off();

    // A is paused, B succeeded.
    expect(readOp(opA.id)?.canonical?.state).toBe("paused");
    expect(readOp(opB.id)?.canonical?.state).toBe("succeeded");

    // Both seq spaces are monotonic 0..N independently.
    const a = readCanonicalEvents(opA.id);
    const b = readCanonicalEvents(opB.id);
    assertMonotonic(a);
    assertMonotonic(b);

    // B has no pause_requested events.
    expect(b.some(e => e.type === "pause_requested")).toBe(false);
  });
});

// ── Flag OFF compatibility ───────────────────────────────────────────────

describe("flag OFF: legacy submit path is unaffected", () => {
  beforeEach(() => {
    // Under the inverted default, OFF must be explicit.
    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "0";
  });
  afterEach(() => {
    delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
  });

  it("opPause on a non-canonical op id returns unknown_op (no canonical state created)", () => {
    const r = opPause("legacy_op_xyz_never_submitted", "actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown_op");
  });

  it("decideSubmitRouting still routes legacy when flag OFF", async () => {
    const { decideSubmitRouting } = await import("../src/canonical-loop/index.js");
    const r = decideSubmitRouting({ lane: "interactive" });
    expect(r.route).toBe("legacy");
    expect(r.flagValue).toBe(false);
  });
});
