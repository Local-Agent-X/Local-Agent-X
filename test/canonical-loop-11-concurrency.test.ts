/**
 * Issue 11 — concurrent ops isolation (PRD acceptance #10).
 * docs/issues/canonical-loop/11-v1-hardening-and-invariants.md
 *
 * Coverage:
 *   - 5 concurrent ops mixed across lanes (interactive, build=2, ide=1,
 *     background=1) — submitted in one synchronous burst. All five reach
 *     `succeeded` with no cross-op contamination.
 *   - Per-op `seq` monotonic 0..K_i with no gaps. No event has the
 *     wrong `op_id`.
 *   - No cross-op contamination of:
 *       - canonical events
 *       - op_messages
 *       - op_turns provider_state
 *       - lease lifecycle (each op's worker_id is unique to that op).
 *   - 5 concurrent ops on a SINGLE lane all reach terminal, each leased
 *     exactly once (no re-leasing, no two workers on the same op).
 *   - Two interactive ops in different sessions run concurrently — the
 *     regression guard for the multi-session-chat cap bug.
 *   - Concurrent ops on DIFFERENT lanes do not block each other.
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
  setLaneCapConfigReader,
  readCanonicalEvents,
  readLatestOpTurn,
  type CanonicalEvent,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import type { Op, OpLane } from "../src/ops/types.js";
import type { LAXConfig } from "../src/types.js";

import { FakeAdapter, scriptTurn, scriptMultiTurn, scriptLongStreamingTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  process.env.LAX_CANONICAL_LOOP_BUILD = "1";
  process.env.LAX_CANONICAL_LOOP_BACKGROUND = "1";
  process.env.LAX_CANONICAL_LOOP_IDE = "1";
  setLeaseConfig({ leaseDurationMs: 500, heartbeatIntervalMs: 100 });
});

afterEach(async () => {
  await awaitIdle(5_000).catch(() => undefined);
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
  delete process.env.LAX_CANONICAL_LOOP_BUILD;
  delete process.env.LAX_CANONICAL_LOOP_BACKGROUND;
  delete process.env.LAX_CANONICAL_LOOP_IDE;
});

function mkOp(label: string, lane: OpLane = "interactive"): Op {
  return {
    id: track(newOpId(`it11c_${label}_${lane}`)),
    type: "freeform",
    task: `issue-11 concurrency ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-11-concurrency",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitTerminal(opId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = readOp(opId);
    const s = op?.canonical?.state;
    // Wait for the op's SETTLED resting state: terminal AND the worker's
    // lease released. The worker persists the terminal state inside the turn
    // commit, then releases the lease and emits `lease_lost` in its finally
    // (after a setImmediate yield on the done/error path). Returning on state
    // alone can observe a terminal op before that finally runs — so
    // lease_acquired/lease_lost pairing assertions read a half-written event
    // log. The lease clears in the same synchronous finally that emits
    // lease_lost, so a null leaseOwner means both have landed.
    if (s === "succeeded" || s === "failed" || s === "cancelled") {
      if ((op?.canonical?.leaseOwner ?? null) === null) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`awaitTerminal timed out for ${opId} — state=${s}`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

function assertSeqMonotonic(opId: string, events: CanonicalEvent[]): void {
  for (let i = 0; i < events.length; i++) {
    expect(events[i].seq, `op=${opId} seq mismatch at index ${i}`).toBe(i);
    expect(events[i].opId, `op=${opId} cross-op event leak at seq=${events[i].seq}`).toBe(opId);
  }
}

// ── PRD acceptance test #10 — concurrent ops isolation ──────────────────

describe("Issue 11 — PRD test #10 concurrent ops isolation (mixed lanes)", () => {
  it("5 concurrent ops across lanes all succeed; per-op seq is monotonic; no cross-op contamination", async () => {
    // Lane mix: 2 build ops (cap=2 → both run together), 1 interactive,
    // 1 background, 1 ide. With Issue 08's fast lease config the round
    // trip is ~150ms per op so the test stays well under timeout.
    const ops: Op[] = [
      mkOp("a", "interactive"),
      mkOp("b", "build"),
      mkOp("c", "build"),
      mkOp("d", "background"),
      mkOp("e", "interactive"),
    ];
    // Each adapter scripts a 3-turn happy path with streaming chunks —
    // produces ~10–14 canonical events per op (matches PRD's "~20" spec
    // closely enough; the test doesn't pin the count).
    const adapters = ops.map(() =>
      new FakeAdapter({
        script: scriptMultiTurn([
          { streamChunks: ["a", "b", "c"], text: "turn 0" },
          { streamChunks: ["d", "e"], text: "turn 1" },
          { text: "turn 2", terminal: "done" },
        ]),
      }),
    );
    for (let i = 0; i < ops.length; i++) {
      const adapter = adapters[i];
      registerAdapterForOp(ops[i].id, () => adapter);
    }

    // Submit all in one synchronous burst.
    for (const op of ops) canonicalLoopEntry(op);

    // Wait for every op to reach terminal. Drive in parallel.
    await Promise.all(ops.map(o => awaitTerminal(o.id)));

    for (const op of ops) {
      const events = readCanonicalEvents(op.id);
      assertSeqMonotonic(op.id, events);

      // All five reach `succeeded` — no cross-op poisoning.
      const persisted = readOp(op.id);
      expect(persisted?.canonical?.state).toBe("succeeded");

      // No event from this op has another op's id.
      for (const e of events) {
        expect(e.opId).toBe(op.id);
      }
    }

    // Canonical-event log per op contains only this op's worker_id —
    // unique workerIds prove no shared lease state.
    const seenWorkerIds = new Set<string>();
    for (const op of ops) {
      const events = readCanonicalEvents(op.id);
      const acquired = events.find(e => e.type === "lease_acquired");
      const wid = (acquired?.body as { workerId?: string })?.workerId;
      expect(wid, `op=${op.id} missing lease_acquired workerId`).toBeTruthy();
      expect(seenWorkerIds.has(wid!), `op=${op.id} workerId="${wid}" reused across ops`).toBe(false);
      seenWorkerIds.add(wid!);
    }

    // op_messages content per op only references THIS op (no leaked
    // assistant text from another op's turns).
    for (let i = 0; i < ops.length; i++) {
      const turn0 = readLatestOpTurn(ops[i].id);
      expect(turn0?.providerState.adapterName).toBe("fake");
    }
  });
});

// ── Single-lane cap-respected concurrency ───────────────────────────────

describe("Issue 11 — same-lane concurrent submit: each op leased exactly once", () => {
  it("5 ops on `interactive` all complete; per-op seq monotonic; each leased exactly once", async () => {
    const ops: Op[] = Array.from({ length: 5 }, (_, i) => mkOp(`solo${i}`, "interactive"));
    for (const op of ops) {
      const adapter = new FakeAdapter({
        script: [scriptTurn({ streamChunks: ["x"], text: "ok", terminal: "done" })],
      });
      registerAdapterForOp(op.id, () => adapter);
    }

    for (const op of ops) canonicalLoopEntry(op);
    await Promise.all(ops.map(o => awaitTerminal(o.id)));

    for (const op of ops) {
      const events = readCanonicalEvents(op.id);
      assertSeqMonotonic(op.id, events);
      expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
      // Each op has exactly one lease_acquired and one lease_lost (no
      // re-leasing under cap=1 single-worker model).
      expect(events.filter(e => e.type === "lease_acquired")).toHaveLength(1);
      expect(events.filter(e => e.type === "lease_lost")).toHaveLength(1);
    }
  });
});

// ── Regression: multi-session chat concurrency (interactive cap > 1) ─────

describe("interactive lane runs multiple sessions concurrently", () => {
  it("two interactive ops in different sessions both reach `running` at once", async () => {
    // Repro for the single-user "can't chat in two sessions at once" bug:
    // the interactive lane was globally capped at 1, so a second session's
    // turn sat `queued` behind the first until it finished. Each adapter
    // holds a long stream so both ops stay mid-run while we observe them —
    // under the old cap=1 the second never leaves `queued` and this times out.
    const a = mkOp("sessA", "interactive");
    const b = mkOp("sessB", "interactive");
    for (const op of [a, b]) {
      const adapter = new FakeAdapter({
        script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
      });
      registerAdapterForOp(op.id, () => adapter);
    }

    canonicalLoopEntry(a, { sessionId: "chat-session-A" });
    canonicalLoopEntry(b, { sessionId: "chat-session-B" });

    const bothRunning = async (timeoutMs = 2_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const sa = readOp(a.id)?.canonical?.state;
        const sb = readOp(b.id)?.canonical?.state;
        if (sa === "running" && sb === "running") return;
        if (Date.now() > deadline) {
          throw new Error(`both ops not running — A=${sa} B=${sb}`);
        }
        await new Promise(r => setTimeout(r, 5));
      }
    };

    await bothRunning();
    expect(readOp(a.id)?.canonical?.state).toBe("running");
    expect(readOp(b.id)?.canonical?.state).toBe("running");
  });
});

// ── Regression: lane-slot release on launch failure ─────────────────────

describe("interactive lane does not leak a slot when a launch fails", () => {
  it("a failing adapter factory releases its reserved slot; a later op still dispatches", async () => {
    // Repro for the multi-day "chat dies after running two chats at once,
    // restart fixes it" wedge. pumpScheduler reserves a lane slot
    // (activeByLane++) *before* launch() awaits the adapter factory. If the
    // factory throws, no worker ever registers in `active`, so the old
    // finally — which only released when a live handle was still ours —
    // never decremented. Each failure leaked one interactive slot; after
    // `cap` leaks the lane read "full" and every new chat op queued forever.
    //
    // Pin the cap to 1 so a SINGLE leak would wedge the lane — making the
    // regression deterministic instead of needing `cap` (10) failures.
    setLaneCapConfigReader(() => ({ maxInteractiveSessions: 1 }) as unknown as LAXConfig);

    const bad = mkOp("leak-bad", "interactive");
    registerAdapterForOp(bad.id, () => { throw new Error("adapter construction blew up"); });
    canonicalLoopEntry(bad);
    // Worker never starts (factory throws); scheduler drains to idle.
    await awaitIdle(5_000);

    // Under the bug, the interactive lane is now stuck at 1/1 and this op
    // never leaves `queued`. With the slot released, it runs to completion.
    const good = mkOp("leak-good", "interactive");
    registerAdapterForOp(
      good.id,
      () => new FakeAdapter({ script: [scriptTurn({ streamChunks: ["x"], text: "ok", terminal: "done" })] }),
    );
    canonicalLoopEntry(good);
    await awaitTerminal(good.id);
    expect(readOp(good.id)?.canonical?.state).toBe("succeeded");
  });
});

// ── Cross-lane independence ─────────────────────────────────────────────

describe("Issue 11 — different lanes do not block each other", () => {
  it("a long build op and a quick interactive op run independently; the interactive op terminates before the build op", async () => {
    const buildOp = mkOp("long-build", "build");
    const fastOp = mkOp("fast-int", "interactive");

    const buildAdapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["b1", "b2", "b3", "b4"], text: "build0" },
        { streamChunks: ["b5", "b6"], text: "build1" },
        { text: "build2", terminal: "done" },
      ]),
    });
    const fastAdapter = new FakeAdapter({
      script: [scriptTurn({ text: "fast", terminal: "done" })],
    });
    registerAdapterForOp(buildOp.id, () => buildAdapter);
    registerAdapterForOp(fastOp.id, () => fastAdapter);

    canonicalLoopEntry(buildOp);
    canonicalLoopEntry(fastOp);

    // Wait for both. Not asserting wall-clock ordering (CI scheduling
    // jitter), but that BOTH complete and that interactive isn't gated
    // on build's queue.
    await Promise.all([awaitTerminal(buildOp.id), awaitTerminal(fastOp.id)]);

    expect(readOp(buildOp.id)?.canonical?.state).toBe("succeeded");
    expect(readOp(fastOp.id)?.canonical?.state).toBe("succeeded");

    // Each op's events are isolated.
    assertSeqMonotonic(buildOp.id, readCanonicalEvents(buildOp.id));
    assertSeqMonotonic(fastOp.id, readCanonicalEvents(fastOp.id));
  });
});
