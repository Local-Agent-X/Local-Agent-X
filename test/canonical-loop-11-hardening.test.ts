/**
 * Issue 11 — hardening (stale workers, delayed adapter results,
 * cross-control determinism).
 * docs/issues/canonical-loop/11-v1-hardening-and-invariants.md
 *
 * The slices in 01–10 each pass their own scenarios; this file proves
 * they compose without leaking under stress and edge interleavings:
 *
 *   - A stale worker that fires `transitionOp` AFTER the op terminated
 *     does not mutate the terminal state — `state-machine` rejects via
 *     `IllegalTransitionError`.
 *   - A delayed adapter result arriving AFTER cancel does not produce
 *     a `turn_committed` event or `op_turns` row.
 *   - A delayed adapter result arriving AFTER lease recovery on a
 *     re-leased op does not commit a stale turn (Issue 08's PK guard).
 *   - cancel-during-pause is deterministic (cancel wins; op terminates
 *     `cancelled` from `paused`).
 *   - cancel-during-redirect is deterministic (cancel wins; redirect
 *     never applies).
 *   - opPause idempotency holds across competing signals — a pause
 *     followed by another pause from a different actor produces one
 *     `pause_requested` event and one `state_changed` to paused.
 *   - opRedirect idempotency holds when the same instructionId is
 *     observable through latest-wins — only one `redirect_applied`
 *     event ever emitted.
 *   - Concurrent control APIs against the same op are race-free at the
 *     storage layer (writes preserve signal columns, recovery clears
 *     lease atomically with state transition).
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
  opRedirect,
  commitTurn,
  insertOpTurn,
  transitionOp,
  IllegalTransitionError,
  readCanonicalEvents,
  readOpTurn,
  readLatestOpTurn,
  readOpMessages,
  subscribeOpStream,
  subscribeOpEvents,
  type ProviderStateEnvelope,
} from "../src/canonical-loop/index.js";
import { readOp, writeOp, newOpId } from "../src/workers/op-store.js";
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
    id: track(newOpId(`it11h_${label}`)),
    type: "freeform",
    task: `issue-11 hardening ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-11-hardening",
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

async function awaitState(opId: string, target: "paused" | "cancelled" | "succeeded", timeoutMs = 3_000): Promise<void> {
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

// ── Stale worker → terminal op cannot be mutated ────────────────────────

describe("Issue 11 — stale worker cannot mutate terminal op", () => {
  it("transitionOp from a terminal state throws IllegalTransitionError; disk state unchanged", async () => {
    const op = mkOp("stale-mutate");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "ok", terminal: "done" })],
    }));
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

    // Pretend a stale worker tries to drive a transition. State machine
    // rejects every attempt because succeeded is absorbing (PRD §10).
    const fresh = readOp(op.id)!;
    let threw = false;
    try {
      transitionOp(fresh, "running", "stale-worker-wakeup");
    } catch (e) {
      threw = true;
      expect(e instanceof IllegalTransitionError).toBe(true);
    }
    expect(threw).toBe(true);

    // Disk state unchanged — terminal succeeded is final.
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
  });

  it("commitTurn against an existing terminal op's turn is a no-op (idempotent guard)", async () => {
    const op = mkOp("stale-commit");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "ok", terminal: "done" })],
    }));
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    const baseEvents = readCanonicalEvents(op.id).length;

    // Late wake-up: stale worker tries to commit turn 0 again. The
    // PK-conflict guard returns inserted=false and emits no events.
    const ps: ProviderStateEnvelope = {
      adapterName: "fake", adapterVersion: "0.0.1", providerPayload: {},
    };
    const result = commitTurn({
      op: readOp(op.id)!,
      turnIdx: 0,
      providerState: ps,
      messages: [{ role: "assistant", content: { text: "duplicate" } }],
      toolCallSummary: [],
      terminalReason: "done",
    });
    expect(result.inserted).toBe(false);

    // No new events; no message duplicates.
    expect(readCanonicalEvents(op.id).length).toBe(baseEvents);
    expect(readOpMessages(op.id)).toHaveLength(1);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
  });
});

// ── Delayed adapter result after cancel ─────────────────────────────────

describe("Issue 11 — delayed adapter result after cancel does not commit", () => {
  it("after a mid-stream cancel reaches `cancelled`, no turn_committed appears even if the adapter's promise resolves later", async () => {
    const op = mkOp("late-result");
    // Long-streaming adapter — abort interrupts mid-stream. The adapter
    // resolves runTurn AFTER the worker sets tracker.cancelled, but
    // BEFORE the worker exits. driveTurn checks tracker.cancelled and
    // returns without commitTurn.
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);

    const firstChunk = new Promise<void>(resolve => {
      const off = subscribeOpStream(op.id, () => { off(); resolve(); });
    });
    canonicalLoopEntry(op);
    await firstChunk;
    expect(opCancel(op.id, "test").ok).toBe(true);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");

    // Give any late tail of the adapter promise a chance to land.
    await new Promise(r => setTimeout(r, 80));

    const events = readCanonicalEvents(op.id);
    expect(events.some(e => e.type === "turn_committed")).toBe(false);
    expect(readOpTurn(op.id, 0)).toBeNull();
  });
});

// ── Delayed adapter result after lease recovery ─────────────────────────

describe("Issue 11 — delayed adapter result after lease recovery does not commit a stale turn", () => {
  it("a synthesized lease-recovery state with op_turns/0 already present accepts no duplicate commit", () => {
    const op = mkOp("recover-stale-commit");
    canonicalLoopEntry(op);

    const ps: ProviderStateEnvelope = {
      adapterName: "fake", adapterVersion: "0.0.1", providerPayload: { from: "worker-A" },
    };
    insertOpTurn({
      opId: op.id,
      turnIdx: 0,
      providerState: ps,
      toolCallSummary: [],
      terminalReason: null,
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
    });

    // Synthesize the post-recovery state (Issue 08): worker A is dead;
    // worker B will re-lease and start at turnIdx=1 because the
    // resume-protocol reads `readLatestOpTurn`. If a hypothetical
    // late wake-up of worker A's adapter still tried to commitTurn(0),
    // the idempotent guard returns inserted=false.
    const fresh = readOp(op.id)!;
    fresh.canonical!.state = "running";
    writeOp(fresh);

    // Late commit attempt — the stale worker A tries to write turn 0
    // again. Idempotent (PRD acceptance #8).
    const result = commitTurn({
      op: readOp(op.id)!,
      turnIdx: 0,
      providerState: { adapterName: "fake", adapterVersion: "0.0.1", providerPayload: { from: "stale-worker-A" } },
      messages: [{ role: "assistant", content: { text: "stale" } }],
      toolCallSummary: [],
      terminalReason: null,
    });
    expect(result.inserted).toBe(false);
    // Original provider_state preserved.
    const turn0 = readOpTurn(op.id, 0);
    expect(turn0?.providerState.providerPayload).toEqual({ from: "worker-A" });
  });
});

// ── Cancel beats pause (PRD §13 precedence under control-API races) ────

describe("Issue 11 — cancel-during-pause is deterministic", () => {
  it("a pause followed by a cancel mid-stream lands on `cancelled`, never on `paused`", async () => {
    const op = mkOp("cancel-during-pause");
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);

    const firstChunk = new Promise<void>(resolve => {
      const off = subscribeOpStream(op.id, () => { off(); resolve(); });
    });
    canonicalLoopEntry(op);
    await firstChunk;

    // Pause first — recorded on the op. Then cancel — cancel ALWAYS
    // wins (PRD §13).
    expect(opPause(op.id, "p").ok).toBe(true);
    expect(opCancel(op.id, "c").ok).toBe(true);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");

    const states = readCanonicalEvents(op.id)
      .filter(e => e.type === "state_changed")
      .map(e => (e.body as { to: string }).to);
    expect(states).toContain("cancelled");
    expect(states).not.toContain("paused");
  });
});

// ── Cancel beats redirect ──────────────────────────────────────────────

describe("Issue 11 — cancel-during-redirect is deterministic", () => {
  it("a redirect followed by a cancel mid-stream: op cancels, redirect_applied never fires", async () => {
    const op = mkOp("cancel-during-redirect");
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);

    const firstChunk = new Promise<void>(resolve => {
      const off = subscribeOpStream(op.id, () => { off(); resolve(); });
    });
    canonicalLoopEntry(op);
    await firstChunk;

    expect(opRedirect(op.id, "redirect-text", "r").ok).toBe(true);
    expect(opCancel(op.id, "c").ok).toBe(true);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");

    const events = readCanonicalEvents(op.id);
    expect(events.some(e => e.type === "redirect_received")).toBe(true);
    expect(events.some(e => e.type === "redirect_applied")).toBe(false);
  });
});

// ── Pause idempotency under racing actors ──────────────────────────────

describe("Issue 11 — pause idempotency under repeated calls", () => {
  it("two opPause calls produce ONE pause_requested event and ONE running→paused state_changed", async () => {
    const op = mkOp("pause-idem-race");
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["x"], text: "t0" },
        { text: "t1", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    let paused = false;
    const off = subscribeOpEvents(op.id, e => {
      if (e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 0 && !paused) {
        paused = true;
        opPause(op.id, "actor-A");
        opPause(op.id, "actor-B"); // idempotent — should not double-emit
      }
    });
    canonicalLoopEntry(op);
    await awaitState(op.id, "paused");
    off();

    const events = readCanonicalEvents(op.id);
    expect(events.filter(e => e.type === "pause_requested")).toHaveLength(1);
    const stateChanges = events.filter(e =>
      e.type === "state_changed" && (e.body as { to: string }).to === "paused",
    );
    expect(stateChanges).toHaveLength(1);

    // Resume to drive op to terminal so afterEach cleanup is clean.
    expect(opResume(op.id, "resumer").ok).toBe(true);
    await awaitTerminal(op.id);
  });
});

// ── Latest-wins redirect after pause + resume ──────────────────────────

describe("Issue 11 — pause+resume+redirect interaction is deterministic", () => {
  it("a redirect set during the paused window is applied on the first resumed turn — exactly one redirect_applied", async () => {
    const op = mkOp("pause-resume-redirect");
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["x"], text: "turn 0" },
        { text: "turn 1 with redirect", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    const off = subscribeOpEvents(op.id, e => {
      if (e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 0) {
        opPause(op.id, "p");
      }
    });
    canonicalLoopEntry(op);
    await awaitState(op.id, "paused");
    off();

    expect(opRedirect(op.id, "follow-up", "r").ok).toBe(true);
    expect(opResume(op.id, "resumer").ok).toBe(true);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

    const events = readCanonicalEvents(op.id);
    expect(events.filter(e => e.type === "redirect_applied")).toHaveLength(1);
    expect(adapter.turnInputs[1].pendingRedirect?.text).toBe("follow-up");

    // op_turns row for turn 1 marks redirect_consumed=true.
    const turn1 = readLatestOpTurn(op.id);
    expect(turn1?.redirectConsumed).toBe(true);
  });
});

// ── Concurrent rapid control calls don't duplicate signals ─────────────

describe("Issue 11 — concurrent control calls preserve signal column integrity", () => {
  it("multiple opPause + opCancel calls in tight sequence emit at most one of each control event before terminal", async () => {
    const op = mkOp("ctrl-burst");
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);

    const firstChunk = new Promise<void>(resolve => {
      const off = subscribeOpStream(op.id, () => { off(); resolve(); });
    });
    canonicalLoopEntry(op);
    await firstChunk;

    // Burst: 3 pauses + 3 cancels in one synchronous flush.
    opPause(op.id, "p1"); opPause(op.id, "p2"); opPause(op.id, "p3");
    opCancel(op.id, "c1"); opCancel(op.id, "c2"); opCancel(op.id, "c3");

    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");

    const events = readCanonicalEvents(op.id);
    // Exactly one durable record per logical control intent.
    expect(events.filter(e => e.type === "pause_requested")).toHaveLength(1);
    expect(events.filter(e => e.type === "cancel_requested")).toHaveLength(1);
    // Exactly one terminal state_changed.
    expect(events.filter(e =>
      e.type === "state_changed" && (e.body as { to: string }).to === "cancelled",
    )).toHaveLength(1);
  });
});
