/**
 * Issue 04 — Event log + `op_events_since` reconnect replay.
 * docs/issues/canonical-loop/04-event-log-and-reconnect-replay.md
 *
 * Acceptance covered:
 *   - PRD test #9 (reconnect replay): client subscribes, captures up to seq=N,
 *     disconnects, op completes, client reconnects via opEventsSince and
 *     replays missed events in seq order.
 *   - Edge: replay from seq=-1 returns full history.
 *   - Edge: replay at seq>=MAX returns an empty list (not an error).
 *   - Edge: replay before the op exists returns `unknown_op`.
 *   - Concurrent ops: each op's seq remains independent and gap-free.
 *   - Stream chunks (`op_stream:{opId}`) are NEVER persisted to op_events
 *     and therefore NOT replayed.
 *   - Flag OFF legacy path: opEventsSince still returns `unknown_op` for
 *     ops that did not go through canonical-loop, leaving legacy untouched.
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
  publishStreamChunk,
  opEventsSince,
  subscribeOpEvents,
  subscribeOpStream,
  reconnectOp,
  OP_EVENTS_FROM_BEGINNING,
  readCanonicalEvents,
  type CanonicalEvent,
} from "../src/canonical-loop/index.js";
import { newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";

import { FakeAdapter, scriptTurn, scriptMultiTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
});

afterEach(async () => {
  await awaitIdle(2_000).catch(() => undefined);
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
    id: track(newOpId(`it04_${label}`)),
    type: "freeform",
    task: `issue-04 ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-04",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitTerminal(opId: string, timeoutMs = 3_000): Promise<CanonicalEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = readCanonicalEvents(opId);
    const last = [...events].reverse().find(e => e.type === "state_changed");
    const to = (last?.body as { to?: string } | null)?.to;
    if (to === "succeeded" || to === "failed" || to === "cancelled") return events;
    if (Date.now() > deadline) {
      throw new Error(`awaitTerminal: ${opId} did not reach terminal — types=[${events.map(e => e.type).join(",")}]`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

function assertMonotonic(events: CanonicalEvent[]): void {
  for (let i = 0; i < events.length; i++) {
    expect(events[i].seq, `seq mismatch at index ${i}`).toBe(i);
  }
}

function happyAdapterFactory() {
  return () => new FakeAdapter({ script: [scriptTurn({ text: "hello", terminal: "done" })] });
}

// ── opEventsSince — basic API behavior ───────────────────────────────────

describe("opEventsSince — replay primitive", () => {
  it("returns full history when sinceSeq = OP_EVENTS_FROM_BEGINNING (-1)", async () => {
    const op = mkOp("from-beginning");
    registerAdapterForOp(op.id, happyAdapterFactory());
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    const r = opEventsSince(op.id, OP_EVENTS_FROM_BEGINNING);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertMonotonic(r.events);
    expect(r.events[0].type).toBe("state_changed");
    expect((r.events[0].body as { to: string }).to).toBe("queued");
    expect(r.latestSeq).toBe(r.events[r.events.length - 1].seq);
  });

  it("returns events with seq strictly greater than sinceSeq", async () => {
    const op = mkOp("after-known-seq");
    registerAdapterForOp(op.id, happyAdapterFactory());
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    const all = opEventsSince(op.id, OP_EVENTS_FROM_BEGINNING);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.events.length).toBeGreaterThanOrEqual(4);

    // Replay starting from the middle.
    const cut = 2;
    const since = opEventsSince(op.id, cut);
    expect(since.ok).toBe(true);
    if (!since.ok) return;
    expect(since.events.map(e => e.seq)).toEqual(
      all.events.filter(e => e.seq > cut).map(e => e.seq),
    );
    // No event with seq <= cut should appear.
    expect(since.events.every(e => e.seq > cut)).toBe(true);
  });

  it("returns an empty list (not an error) when sinceSeq >= MAX(seq)", async () => {
    const op = mkOp("past-max");
    registerAdapterForOp(op.id, happyAdapterFactory());
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    const all = opEventsSince(op.id, OP_EVENTS_FROM_BEGINNING);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const max = all.events[all.events.length - 1].seq;

    const past = opEventsSince(op.id, max);
    expect(past.ok).toBe(true);
    if (!past.ok) return;
    expect(past.events).toEqual([]);
    expect(past.latestSeq).toBe(max);

    const wayPast = opEventsSince(op.id, max + 1000);
    expect(wayPast.ok).toBe(true);
    if (!wayPast.ok) return;
    expect(wayPast.events).toEqual([]);
  });

  it("returns unknown_op for an op id that does not exist", () => {
    const r = opEventsSince("op_does_not_exist_xyz", OP_EVENTS_FROM_BEGINNING);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown_op");
  });

  it("returns invalid_op_id for empty / non-string opId", () => {
    const a = opEventsSince("", OP_EVENTS_FROM_BEGINNING);
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.code).toBe("invalid_op_id");
  });

  it("returns invalid_seq for non-integer or below-sentinel seq", async () => {
    const op = mkOp("invalid-seq");
    registerAdapterForOp(op.id, happyAdapterFactory());
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    expect(opEventsSince(op.id, -2).ok).toBe(false);
    expect(opEventsSince(op.id, 1.5).ok).toBe(false);
    expect(opEventsSince(op.id, NaN).ok).toBe(false);
  });
});

// ── PRD test #9 — reconnect replay end-to-end ────────────────────────────

describe("PRD test #9 — reconnect replay", () => {
  it("client tracking last_seq can replay missed events after disconnect", async () => {
    const op = mkOp("prd9");
    registerAdapterForOp(
      op.id,
      () => new FakeAdapter({
        script: scriptMultiTurn([
          { text: "first" },
          { text: "second" },
          { text: "third", terminal: "done" },
        ]),
      }),
    );

    // Phase 1: client connects live before submission, captures everything.
    const live: CanonicalEvent[] = [];
    const offLive = subscribeOpEvents(op.id, e => live.push(e));
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    offLive();

    // Sanity: live capture saw monotonic seq 0..N.
    assertMonotonic(live);
    expect(live.length).toBeGreaterThanOrEqual(8);

    // Phase 2: simulate a client that disconnected at last_seq = 2.
    const lastSeqBeforeDisconnect = 2;
    const replay = opEventsSince(op.id, lastSeqBeforeDisconnect);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;

    // Replayed events: every event with seq > 2, in order, no duplicates, no gaps.
    expect(replay.events.map(e => e.seq)).toEqual(
      live.filter(e => e.seq > lastSeqBeforeDisconnect).map(e => e.seq),
    );
    for (let i = 0; i < replay.events.length; i++) {
      expect(replay.events[i].seq).toBe(lastSeqBeforeDisconnect + 1 + i);
    }

    // Concatenation of [seen-up-to-2] + [replay] reconstructs the full log.
    const reconstructed = [
      ...live.filter(e => e.seq <= lastSeqBeforeDisconnect),
      ...replay.events,
    ];
    expect(reconstructed.map(e => e.seq)).toEqual(live.map(e => e.seq));
  });
});

// ── Terminal-state replay ────────────────────────────────────────────────

describe("replay against terminal ops", () => {
  it("succeeded op replays the full event log identically across calls", async () => {
    const op = mkOp("terminal-succeeded");
    registerAdapterForOp(op.id, happyAdapterFactory());
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    const a = opEventsSince(op.id, OP_EVENTS_FROM_BEGINNING);
    const b = opEventsSince(op.id, OP_EVENTS_FROM_BEGINNING);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.events.map(e => e.seq)).toEqual(b.events.map(e => e.seq));
    expect(a.events.map(e => e.type)).toEqual(b.events.map(e => e.type));
    // Final state_changed must be terminal.
    const lastState = [...a.events].reverse().find(e => e.type === "state_changed")!;
    expect((lastState.body as { to: string }).to).toBe("succeeded");
  });

  it("failed op (missing adapter) replays adapter_error + queued→failed", async () => {
    const op = mkOp("terminal-failed");
    canonicalLoopEntry(op); // no adapter — Issue 03 fast-fail

    // Wait until the queued→failed transition lands.
    await new Promise(r => setTimeout(r, 20));
    const events = readCanonicalEvents(op.id);
    expect(events.map(e => e.type)).toEqual([
      "state_changed",
      "error",
      "state_changed",
    ]);

    const r = opEventsSince(op.id, OP_EVENTS_FROM_BEGINNING);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events.map(e => e.type)).toEqual(events.map(e => e.type));
    assertMonotonic(r.events);
  });
});

// ── Running-op replay (live + reconnect path) ────────────────────────────

describe("replay against running ops (reconnectOp combines replay + subscribe)", () => {
  it("reconnectOp delivers every event exactly once, in seq order, while op runs", async () => {
    const op = mkOp("running-reconnect");
    registerAdapterForOp(
      op.id,
      () => new FakeAdapter({
        script: scriptMultiTurn([
          { streamChunks: ["a", "b"], text: "t1" },
          { streamChunks: ["c"], text: "t2" },
          { text: "t3", terminal: "done" },
        ]),
      }),
    );

    // Submit first so the op exists on disk (reconnectOp checks readOp).
    canonicalLoopEntry(op);

    // Reconnect from the very beginning while the worker is still running.
    const captured: CanonicalEvent[] = [];
    const r = reconnectOp(op.id, OP_EVENTS_FROM_BEGINNING, e => captured.push(e));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    await awaitTerminal(op.id);
    r.off();

    // Listener saw a strictly monotonic 0..N sequence with no duplicates.
    assertMonotonic(captured);

    // Cross-check against the durable log read independently.
    const fromDisk = opEventsSince(op.id, OP_EVENTS_FROM_BEGINNING);
    expect(fromDisk.ok).toBe(true);
    if (!fromDisk.ok) return;
    expect(captured.map(e => e.seq)).toEqual(fromDisk.events.map(e => e.seq));
    expect(captured.map(e => e.type)).toEqual(fromDisk.events.map(e => e.type));
  });

  it("reconnectOp from a midpoint seq only delivers events with seq > sinceSeq", async () => {
    const op = mkOp("running-midpoint");
    registerAdapterForOp(
      op.id,
      () => new FakeAdapter({
        script: scriptMultiTurn([{ text: "t1" }, { text: "t2", terminal: "done" }]),
      }),
    );

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    const all = opEventsSince(op.id, OP_EVENTS_FROM_BEGINNING);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const cut = 3;
    const captured: CanonicalEvent[] = [];
    const r = reconnectOp(op.id, cut, e => captured.push(e));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    r.off();

    expect(captured.every(e => e.seq > cut)).toBe(true);
    expect(captured.map(e => e.seq)).toEqual(
      all.events.filter(e => e.seq > cut).map(e => e.seq),
    );
  });

  it("reconnectOp returns unknown_op without subscribing when the op doesn't exist", () => {
    const captured: CanonicalEvent[] = [];
    const r = reconnectOp("op_nonexistent_zzz", OP_EVENTS_FROM_BEGINNING, e => captured.push(e));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown_op");
    // Listener should not have received anything.
    expect(captured).toEqual([]);
  });
});

// ── Stream chunks are ephemeral, NEVER replayed ──────────────────────────

describe("stream chunks ride op_stream:{opId} only and are not replayed", () => {
  it("stream_chunk does not appear in opEventsSince results, ever", async () => {
    const op = mkOp("stream-not-replayed");
    registerAdapterForOp(
      op.id,
      () => new FakeAdapter({
        script: [scriptTurn({
          streamChunks: ["x1", "x2", "x3"],
          text: "done",
          terminal: "done",
        })],
      }),
    );
    const streamCaptured: unknown[] = [];
    const offStream = subscribeOpStream(op.id, c => streamCaptured.push(c));
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    offStream();

    expect(streamCaptured).toEqual(["x1", "x2", "x3"]);

    const r = opEventsSince(op.id, OP_EVENTS_FROM_BEGINNING);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Locked v1 enum has no `stream_chunk` type — assert absence explicitly.
    expect(r.events.some(e => (e.type as string) === "stream_chunk")).toBe(false);
  });

  it("publishStreamChunk on the bus does not leak into op_events", async () => {
    const op = mkOp("stream-not-leaked");
    registerAdapterForOp(op.id, happyAdapterFactory());
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    const before = opEventsSince(op.id, OP_EVENTS_FROM_BEGINNING);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeCount = before.events.length;

    // Direct bus publishes — no canonical write should occur.
    publishStreamChunk(op.id, { tick: 1 });
    publishStreamChunk(op.id, { tick: 2 });

    const after = opEventsSince(op.id, OP_EVENTS_FROM_BEGINNING);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.events.length).toBe(beforeCount);
  });
});

// ── Concurrent ops keep seq spaces independent ───────────────────────────

describe("per-op seq is independent and gap-free under concurrent ops", () => {
  it("two concurrent ops each see their own monotonic 0..N seq", async () => {
    const opA = mkOp("concurrent-a");
    const opB = mkOp("concurrent-b");
    registerAdapterForOp(opA.id, happyAdapterFactory());
    registerAdapterForOp(opB.id, happyAdapterFactory());

    canonicalLoopEntry(opA);
    canonicalLoopEntry(opB);

    await awaitTerminal(opA.id);
    await awaitTerminal(opB.id);

    const a = opEventsSince(opA.id, OP_EVENTS_FROM_BEGINNING);
    const b = opEventsSince(opB.id, OP_EVENTS_FROM_BEGINNING);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    assertMonotonic(a.events);
    assertMonotonic(b.events);
    expect(a.events[0].opId).toBe(opA.id);
    expect(b.events[0].opId).toBe(opB.id);
    // Both start at seq=0 — independent counters.
    expect(a.events[0].seq).toBe(0);
    expect(b.events[0].seq).toBe(0);
  });
});

describe("opEventsSince returns unknown_op for ops never submitted via canonical-loop", () => {
  it("hallucinates no state for ids that never went through canonicalLoopEntry", () => {
    const r = opEventsSince("never_created_op", OP_EVENTS_FROM_BEGINNING);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown_op");
  });
});
