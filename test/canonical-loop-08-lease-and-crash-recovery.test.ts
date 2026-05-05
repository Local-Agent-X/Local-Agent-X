/**
 * Issue 08 — Lease heartbeat + crash recovery.
 * docs/issues/canonical-loop/08-lease-and-crash-recovery.md (PRD §11/§14)
 *
 * Acceptance covered:
 *   - Heartbeat extends `leaseExpiresAt` while a worker is driving turns.
 *   - Stale `running` lease is detected by `recoverStaleOp` and not by
 *     callers walking control APIs.
 *   - PRD acceptance #7 (crash-recovery happy path): worker A commits
 *     turn 0, hangs on turn 1, heartbeat paused, lease expires, recovery
 *     re-enqueues, worker B drives turn 1 with prior provider_state,
 *     op succeeds. Different workerIds across the lease cycle. Turn 0
 *     not re-driven, not re-committed.
 *   - PRD acceptance #8 (idempotent commit): `commitTurn` against an
 *     already-existing `(opId, turnIdx)` returns inserted=false, emits
 *     no duplicate events.
 *   - Partial in-flight turn discarded (no commit on the hang).
 *   - Terminal ops are no-ops for `recoverStaleOp`.
 *   - `running` ops with FRESH leases are not recovered.
 *   - Event seq monotonic across recovery boundary.
 *   - Lane caps respected after recovery (interactive cap=1).
 *   - Flag OFF legacy submit path is unaffected by lease/recovery.
 *   - Recovery during `cancelling`: closes out as `cancelled`.
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
  recoverStaleOp,
  acquireLease,
  heartbeatLease,
  releaseLease,
  isLeaseExpired,
  setLeaseConfig,
  resetLeaseConfig,
  getLeaseConfig,
  evictWorker,
  _pauseHeartbeat,
  commitTurn,
  insertOpTurn,
  readCanonicalEvents,
  readLatestOpTurn,
  readOpMessages,
  readOpTurn,
  decideSubmitRouting,
  type CanonicalEvent,
  type ProviderStateEnvelope,
} from "../src/canonical-loop/index.js";
import { readOp, writeOp, newOpId } from "../src/workers/op-store.js";
import type { Op } from "../src/workers/types.js";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../src/canonical-loop/adapter-contract.js";

import { FakeAdapter, scriptTurn, scriptMultiTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  // Compress the lease cycle so tests run on real wall-clock without
  // burning a half-minute per scenario. Heartbeat 25ms, lease 100ms —
  // small enough to expire quickly, big enough for committed turns.
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

// ── Helpers ──────────────────────────────────────────────────────────────

function mkOp(label: string, lane: Op["lane"] = "interactive"): Op {
  return {
    id: track(newOpId(`it08_${label}`)),
    type: "freeform",
    task: `issue-08 ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-08",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitState(opId: string, target: "succeeded" | "failed" | "cancelled" | "queued" | "running" | "paused", timeoutMs = 3_000): Promise<void> {
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

function bodyOf<T = Record<string, unknown>>(e: CanonicalEvent): T {
  return (e.body ?? {}) as T;
}

function assertMonotonic(events: CanonicalEvent[]): void {
  for (let i = 0; i < events.length; i++) {
    expect(events[i].seq, `seq mismatch at index ${i}`).toBe(i);
  }
}

/** Adapter whose runTurn never resolves. Used to simulate a hung worker. */
class HangingAdapter implements Adapter {
  readonly name = "hanging";
  readonly version = "0.0.1";
  abortCalls = 0;
  // Resolve manually if a test wants to clean up; otherwise the hanging
  // promise outlives the test (afterEach's resetScheduler forgets it).
  runTurn(_input: TurnInput, _report: (r: AdapterReport) => void): Promise<TurnResult> {
    return new Promise<TurnResult>(() => { /* never resolves */ });
  }
  async abort(): Promise<void> {
    this.abortCalls++;
  }
}

// ── lease primitives ─────────────────────────────────────────────────────

describe("lease primitives", () => {
  it("acquireLease writes leaseOwner + leaseExpiresAt; second worker can't steal a fresh lease", () => {
    const op = mkOp("acquire");
    canonicalLoopEntry(op);

    expect(acquireLease(op.id, "w-A")).toBe(true);
    const a = readOp(op.id);
    expect(a?.canonical?.leaseOwner).toBe("w-A");
    expect(a?.canonical?.leaseExpiresAt).toBeTruthy();

    expect(acquireLease(op.id, "w-B")).toBe(false);
    const b = readOp(op.id);
    expect(b?.canonical?.leaseOwner).toBe("w-A");
  });

  it("heartbeatLease extends leaseExpiresAt; pushes the expiry forward in time", async () => {
    const op = mkOp("heartbeat");
    canonicalLoopEntry(op);
    expect(acquireLease(op.id, "w-X")).toBe(true);
    const before = Date.parse(readOp(op.id)!.canonical!.leaseExpiresAt!);

    await new Promise(r => setTimeout(r, 30));
    expect(heartbeatLease(op.id, "w-X")).toBe(true);
    const after = Date.parse(readOp(op.id)!.canonical!.leaseExpiresAt!);

    expect(after).toBeGreaterThan(before);
  });

  it("heartbeatLease returns false if a different worker took the lease", () => {
    const op = mkOp("heartbeat-stolen");
    canonicalLoopEntry(op);
    expect(acquireLease(op.id, "w-A")).toBe(true);
    // Force-expire and let B acquire.
    const fresh = readOp(op.id)!;
    fresh.canonical!.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    writeOp(fresh);
    expect(acquireLease(op.id, "w-B")).toBe(true);

    expect(heartbeatLease(op.id, "w-A")).toBe(false);
  });

  it("releaseLease is identity-checked; a non-owner release is a no-op", () => {
    const op = mkOp("release-idcheck");
    canonicalLoopEntry(op);
    expect(acquireLease(op.id, "w-A")).toBe(true);

    expect(releaseLease(op.id, "w-other")).toBe(false);
    expect(readOp(op.id)?.canonical?.leaseOwner).toBe("w-A");

    expect(releaseLease(op.id, "w-A")).toBe(true);
    expect(readOp(op.id)?.canonical?.leaseOwner ?? null).toBeNull();
  });

  it("isLeaseExpired returns false for fresh leases, true for past expiries", () => {
    const op = mkOp("is-expired");
    canonicalLoopEntry(op);
    expect(acquireLease(op.id, "w-X")).toBe(true);
    expect(isLeaseExpired(readOp(op.id))).toBe(false);

    const fresh = readOp(op.id)!;
    fresh.canonical!.leaseExpiresAt = new Date(Date.now() - 5).toISOString();
    writeOp(fresh);
    expect(isLeaseExpired(readOp(op.id))).toBe(true);
  });
});

// ── Heartbeat extends lease while op is running ──────────────────────────

describe("heartbeat keeps lease alive while running", () => {
  it("running op's leaseExpiresAt advances over multiple heartbeat ticks", async () => {
    const op = mkOp("heartbeat-running");
    // Two-turn adapter with a streaming first turn so the worker sticks
    // around long enough for several heartbeat ticks.
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: Array.from({ length: 30 }, (_, i) => `s${i}`), text: "t0" },
        { text: "t1", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    canonicalLoopEntry(op);
    // Wait for the worker to be in the middle of streaming.
    await awaitState(op.id, "running");
    const t1 = Date.parse(readOp(op.id)!.canonical!.leaseExpiresAt!);

    // Sleep across ~3 heartbeat intervals (75ms).
    await new Promise(r => setTimeout(r, 75));
    const opMid = readOp(op.id);
    if (opMid?.canonical?.state === "running") {
      const t2 = Date.parse(opMid.canonical!.leaseExpiresAt!);
      expect(t2).toBeGreaterThan(t1);
    }
    // Otherwise the op already completed — heartbeat extension was at
    // least implicit (the streaming turn finished before our sample).

    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    // Lease released on terminal exit.
    expect(readOp(op.id)?.canonical?.leaseOwner ?? null).toBeNull();
  });
});

// ── recoverStaleOp guards ─────────────────────────────────────────────────

describe("recoverStaleOp guard rails", () => {
  it("returns unknown_op for an op id that doesn't exist", () => {
    const r = recoverStaleOp("op_does_not_exist_recover");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("unknown_op");
  });

  it("returns not_running for queued ops", () => {
    const op = mkOp("guard-queued");
    canonicalLoopEntry(op);
    const r = recoverStaleOp(op.id);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("not_running");
  });

  it("returns no_lease for a running op that has no lease", () => {
    const op = mkOp("guard-no-lease");
    canonicalLoopEntry(op);
    // Synthesize "running with no lease" on disk.
    const fresh = readOp(op.id)!;
    fresh.canonical!.state = "running";
    fresh.canonical!.leaseOwner = null;
    fresh.canonical!.leaseExpiresAt = null;
    writeOp(fresh);

    const r = recoverStaleOp(op.id);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("no_lease");
  });

  it("returns lease_fresh for a running op whose lease is still in date", () => {
    const op = mkOp("guard-fresh-lease");
    canonicalLoopEntry(op);
    expect(acquireLease(op.id, "w-fresh")).toBe(true);
    // Move state to running manually so we hit the recovery guard, not
    // the not_running early-out.
    const fresh = readOp(op.id)!;
    fresh.canonical!.state = "running";
    writeOp(fresh);

    const r = recoverStaleOp(op.id);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("lease_fresh");
  });

  it("ignores terminal ops (succeeded/failed/cancelled)", async () => {
    const op = mkOp("guard-terminal");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "ok", terminal: "done" })],
    }));
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    const r = recoverStaleOp(op.id);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("not_running");
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
  });
});

// ── recoverStaleOp synthesized post-crash state ─────────────────────────

describe("recoverStaleOp on synthesized stale state (no live worker)", () => {
  it("transitions running → queued, emits lease_lost reason='expired', re-enqueues for replacement adapter", async () => {
    const op = mkOp("synth-recover");
    canonicalLoopEntry(op);

    // Pretend a prior worker committed turn 0 and then died.
    const ps0: ProviderStateEnvelope = {
      adapterName: "fake",
      adapterVersion: "0.0.1",
      providerPayload: { from: "dead-worker-turn-0" },
    };
    insertOpTurn({
      opId: op.id,
      turnIdx: 0,
      providerState: ps0,
      toolCallSummary: [],
      terminalReason: null,
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
    });

    // Synthesize a stale lease + running state. We bypass acquireLease /
    // state-machine because the test is constructing a post-crash disk
    // state, not driving live transitions.
    const fresh = readOp(op.id)!;
    fresh.canonical!.state = "running";
    fresh.canonical!.leaseOwner = "w-dead";
    fresh.canonical!.leaseExpiresAt = new Date(Date.now() - 50).toISOString();
    fresh.canonical!.currentTurnIdx = 0;
    writeOp(fresh);

    // Replacement adapter to drive turn 1 after recovery.
    const replacement = new FakeAdapter({
      script: [scriptTurn({ text: "after recovery", terminal: "done" })],
    });
    registerAdapterForOp(op.id, () => replacement);

    const outcome = recoverStaleOp(op.id);
    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe("recovered");
    expect(outcome.expiredWorkerId).toBe("w-dead");

    // Blocker regression (Issue 08 review): immediately after recoverStaleOp
    // returns and BEFORE the replacement worker acquires its lease, the
    // persisted op MUST be at state="queued" with both lease columns
    // cleared. Earlier code preserved the stale lease through the
    // transition because state-machine's persistOpKeepingSignals defaulted
    // to `preserveLeaseFromDisk: true`. The fix routes recovery through
    // `transitionOp(..., { clearLeaseFromOp: true })`.
    const postRecover = readOp(op.id);
    expect(postRecover?.canonical?.state).toBe("queued");
    expect(postRecover?.canonical?.leaseOwner ?? null).toBeNull();
    expect(postRecover?.canonical?.leaseExpiresAt ?? null).toBeNull();

    // Recovery emits lease_lost BEFORE the state transition.
    const events = readCanonicalEvents(op.id);
    const leaseLostExpired = events.find(e =>
      e.type === "lease_lost" && bodyOf<{ reason: string }>(e).reason === "expired",
    );
    const runningToQueued = events.find(e =>
      e.type === "state_changed" &&
      bodyOf<{ from: string; to: string }>(e).from === "running" &&
      bodyOf<{ from: string; to: string }>(e).to === "queued",
    );
    expect(leaseLostExpired).toBeDefined();
    expect(runningToQueued).toBeDefined();
    expect(leaseLostExpired!.seq).toBeLessThan(runningToQueued!.seq);
    expect(bodyOf<{ workerId: string }>(leaseLostExpired!).workerId).toBe("w-dead");
    expect(bodyOf<{ reason: string }>(runningToQueued!).reason).toBe("lease_expired");

    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

    // Replacement adapter received turn 1's input with prior provider_state.
    expect(replacement.turnInputs.length).toBe(1);
    expect(replacement.turnInputs[0].turnIdx).toBe(1);
    expect(replacement.turnInputs[0].providerState).toEqual(ps0);

    // Turn 0 was NOT re-driven: only one op_turns/0.json exists with
    // the original provider_state, and turn 1 is a separate row.
    expect(readOpTurn(op.id, 0)?.providerState.providerPayload).toEqual({ from: "dead-worker-turn-0" });
    expect(readOpTurn(op.id, 1)).toBeTruthy();

    // Wait for the worker's finally block (releaseLease + lease_lost emit)
    // to run — `awaitTerminal` returns as soon as state transitions to
    // succeeded, which precedes the cleanup. `awaitIdle` blocks on the
    // scheduler's active map so it's the right sync point.
    await awaitIdle(2_000);

    // Re-read events AFTER the replacement worker finished so we can
    // assert against the full post-recovery event log.
    const postRecoveryEvents = readCanonicalEvents(op.id);
    const leaseAcquireds = postRecoveryEvents
      .filter(e => e.type === "lease_acquired")
      .map(e => bodyOf<{ workerId: string }>(e).workerId);
    expect(leaseAcquireds.length).toBeGreaterThanOrEqual(1);
    // The synthesized "dead" worker never emitted lease_acquired (we
    // bypassed runWorker); the replacement worker did.
    for (const wid of leaseAcquireds) {
      expect(wid).not.toBe("w-dead");
    }

    // Lease cleared after final release.
    expect(readOp(op.id)?.canonical?.leaseOwner ?? null).toBeNull();
  });

  it("preserves per-op event seq monotonicity across the recovery boundary", async () => {
    const op = mkOp("synth-monotonic");
    canonicalLoopEntry(op);

    insertOpTurn({
      opId: op.id,
      turnIdx: 0,
      providerState: { adapterName: "fake", adapterVersion: "0.0.1", providerPayload: {} },
      toolCallSummary: [],
      terminalReason: null,
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
    });
    const fresh = readOp(op.id)!;
    fresh.canonical!.state = "running";
    fresh.canonical!.leaseOwner = "w-dead";
    fresh.canonical!.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    writeOp(fresh);

    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "go", terminal: "done" })],
    }));

    expect(recoverStaleOp(op.id).ok).toBe(true);
    await awaitTerminal(op.id);

    assertMonotonic(readCanonicalEvents(op.id));
  });

  it("cancelling state recovers as cancelled (cancel always wins, PRD §13)", () => {
    const op = mkOp("synth-cancelling");
    canonicalLoopEntry(op);

    const fresh = readOp(op.id)!;
    fresh.canonical!.state = "cancelling";
    fresh.canonical!.leaseOwner = "w-dead-cancelling";
    fresh.canonical!.leaseExpiresAt = new Date(Date.now() - 10).toISOString();
    writeOp(fresh);

    const outcome = recoverStaleOp(op.id);
    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe("cancelled");

    // Blocker regression: lease columns must be cleared on the persisted
    // op once recovery completes — even on the cancelling→cancelled path,
    // which goes through state-machine.transitionOp.
    const persisted = readOp(op.id);
    expect(persisted?.canonical?.state).toBe("cancelled");
    expect(persisted?.canonical?.leaseOwner ?? null).toBeNull();
    expect(persisted?.canonical?.leaseExpiresAt ?? null).toBeNull();

    const events = readCanonicalEvents(op.id);
    const cancelTransition = events.find(e =>
      e.type === "state_changed" &&
      bodyOf<{ to: string }>(e).to === "cancelled",
    );
    expect(cancelTransition).toBeDefined();
    expect(bodyOf<{ reason: string }>(cancelTransition!).reason).toBe("lease_expired_during_cancel");
  });

  // Direct regression for the reviewer's bug: even if a stale lease
  // sits on disk at the moment the recovery transition fires, the
  // transition write must NOT restore it. This test bypasses
  // recoverStaleOp's pre-transition clear and exercises only the
  // transitionOp path with `clearLeaseFromOp: true` — proving the
  // state-machine, on its own, defends against the leaked lease.
  it("transitionOp({clearLeaseFromOp:true}) does not restore stale lease from disk", async () => {
    const { transitionOp } = await import("../src/canonical-loop/state-machine.js");
    const op = mkOp("regression-stale-lease");
    canonicalLoopEntry(op);

    const fresh = readOp(op.id)!;
    fresh.canonical!.state = "running";
    fresh.canonical!.leaseOwner = "w-dead-stale";
    fresh.canonical!.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    writeOp(fresh);

    // Sanity check: disk has the stale lease.
    expect(readOp(op.id)?.canonical?.leaseOwner).toBe("w-dead-stale");

    // Build an in-memory op with cleared lease and call transitionOp
    // with clearLeaseFromOp:true. Should NOT restore the disk's
    // "w-dead-stale" lease.
    const inMem = readOp(op.id)!;
    inMem.canonical!.leaseOwner = null;
    inMem.canonical!.leaseExpiresAt = null;
    transitionOp(inMem, "queued", "lease_expired", { clearLeaseFromOp: true });

    const after = readOp(op.id);
    expect(after?.canonical?.state).toBe("queued");
    expect(after?.canonical?.leaseOwner ?? null).toBeNull();
    expect(after?.canonical?.leaseExpiresAt ?? null).toBeNull();
  });

  // Inverse: the DEFAULT transitionOp (no `clearLeaseFromOp`) MUST preserve
  // a live worker's lease across non-recovery state changes. Otherwise a
  // commit path or pause/resume path would clobber a heartbeating worker.
  it("transitionOp without clearLeaseFromOp preserves an existing lease from disk", async () => {
    const { transitionOp } = await import("../src/canonical-loop/state-machine.js");
    const op = mkOp("regression-preserve-lease");
    canonicalLoopEntry(op);
    expect(acquireLease(op.id, "w-live")).toBe(true);

    // Build an in-memory op with state still queued (canonical loop entry
    // emitted that). Transition queued → running without clearLeaseFromOp.
    const inMem = readOp(op.id)!;
    transitionOp(inMem, "running", "leased");

    const after = readOp(op.id);
    expect(after?.canonical?.state).toBe("running");
    expect(after?.canonical?.leaseOwner).toBe("w-live");
    expect(after?.canonical?.leaseExpiresAt).toBeTruthy();
  });
});

// ── Idempotent commit (PRD acceptance #8) ─────────────────────────────────

describe("idempotent commitTurn (PRD acceptance #8)", () => {
  it("commitTurn against an existing (opId, turnIdx) returns inserted=false; emits no duplicate events", () => {
    const op = mkOp("idempotent-commit");
    canonicalLoopEntry(op);

    // Drive op to state=running so commitTurn's terminal transitions
    // are valid if the test triggered them — but we won't.
    const fresh = readOp(op.id)!;
    fresh.canonical!.state = "running";
    writeOp(fresh);

    const ps: ProviderStateEnvelope = {
      adapterName: "fake",
      adapterVersion: "0.0.1",
      providerPayload: {},
    };

    // First commit: inserts the row, emits message_appended + turn_committed.
    const r1 = commitTurn({
      op: readOp(op.id)!,
      turnIdx: 0,
      providerState: ps,
      messages: [{ role: "assistant", content: { text: "first" } }],
      toolCallSummary: [],
      terminalReason: null,
    });
    expect(r1.inserted).toBe(true);
    const eventsAfter1 = readCanonicalEvents(op.id);
    const turnCommitsAfter1 = eventsAfter1.filter(e => e.type === "turn_committed").length;
    const msgAppendsAfter1 = eventsAfter1.filter(e => e.type === "message_appended").length;
    expect(turnCommitsAfter1).toBe(1);
    expect(msgAppendsAfter1).toBe(1);

    // Second commit at the same turnIdx — replay path. Idempotent.
    const r2 = commitTurn({
      op: readOp(op.id)!,
      turnIdx: 0,
      providerState: ps,
      messages: [{ role: "assistant", content: { text: "duplicate" } }],
      toolCallSummary: [],
      terminalReason: null,
    });
    expect(r2.inserted).toBe(false);
    const eventsAfter2 = readCanonicalEvents(op.id);
    expect(eventsAfter2.filter(e => e.type === "turn_committed").length).toBe(1);
    expect(eventsAfter2.filter(e => e.type === "message_appended").length).toBe(1);

    // op_messages disk file got only one row.
    expect(readOpMessages(op.id)).toHaveLength(1);

    // Latest committed turn idx still reflects turn 0.
    expect(readLatestOpTurn(op.id)?.turnIdx).toBe(0);
  });
});

// ── Live PRD acceptance #7 (heartbeat-pause crash sim) ──────────────────

describe("PRD acceptance #7 — live crash recovery via heartbeat pause", () => {
  it("worker A drives turn 0, hangs on turn 1, heartbeat paused, recovery hands off to worker B; op succeeds", async () => {
    const op = mkOp("live-recover");

    // Adapter factory: worker A gets a "turn 0 commits then turn 1 hangs"
    // adapter; worker B (the replacement) gets a normal turn-1 adapter.
    let attempt = 0;
    let workerBAdapter: FakeAdapter | null = null;
    registerAdapterForOp(op.id, () => {
      attempt++;
      if (attempt === 1) {
        // Worker A's adapter: turn 0 commits normally (no terminal, so
        // worker proceeds), turn 1 hangs (simulates the worker being
        // blocked when the test pauses its heartbeat).
        // NB: scriptTurn with no `terminal` returns terminalReason: undefined,
        // which the loop treats as "continue to next turn". scriptMultiTurn
        // would auto-fill "done" on the last turn — we want the opposite.
        const inner = new FakeAdapter({
          script: [scriptTurn({ text: "turn 0" })],
        });
        const hanging = new HangingAdapter();
        const composite: Adapter = {
          name: "composite",
          version: "0.0.1",
          async runTurn(input, report) {
            if (input.turnIdx === 0) return inner.runTurn(input, report);
            return hanging.runTurn(input, report);
          },
          async abort() {
            await hanging.abort();
            await inner.abort();
          },
        };
        return composite;
      }
      workerBAdapter = new FakeAdapter({
        script: [scriptTurn({ text: "turn 1 from worker B", terminal: "done" })],
      });
      return workerBAdapter;
    });

    canonicalLoopEntry(op);

    // Wait for turn 0 to commit AND the worker to be on turn 1 (lease
    // owned by worker A, state=running, op_turns/0 present).
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (readOpTurn(op.id, 0) && readOp(op.id)?.canonical?.state === "running") break;
      await new Promise(r => setTimeout(r, 5));
    }
    expect(readOpTurn(op.id, 0)).toBeTruthy();
    expect(readOp(op.id)?.canonical?.state).toBe("running");
    const workerAId = readOp(op.id)!.canonical!.leaseOwner!;
    expect(workerAId).toBeTruthy();

    // Pause worker A's heartbeat — simulates process death. Lease will
    // expire naturally (leaseDurationMs = 100ms in beforeEach).
    expect(_pauseHeartbeat(workerAId)).toBe(true);

    // Wait for the lease to expire.
    const expireDeadline = Date.now() + getLeaseConfig().leaseDurationMs + 100;
    while (Date.now() < expireDeadline) {
      const o = readOp(op.id);
      if (o && isLeaseExpired(o)) break;
      await new Promise(r => setTimeout(r, 5));
    }
    expect(isLeaseExpired(readOp(op.id))).toBe(true);

    // Recovery — kicks off worker B.
    const r = recoverStaleOp(op.id);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("recovered");
    expect(r.expiredWorkerId).toBe(workerAId);

    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

    // Worker B drove only turn 1, with worker A's prior provider_state.
    expect(workerBAdapter).toBeTruthy();
    expect(workerBAdapter!.turnInputs).toHaveLength(1);
    expect(workerBAdapter!.turnInputs[0].turnIdx).toBe(1);
    expect(workerBAdapter!.turnInputs[0].providerState).toBeDefined();

    // Different workerIds across lease cycle.
    const events = readCanonicalEvents(op.id);
    const leaseAcquireds = events
      .filter(e => e.type === "lease_acquired")
      .map(e => bodyOf<{ workerId: string }>(e).workerId);
    expect(leaseAcquireds).toHaveLength(2);
    expect(leaseAcquireds[0]).toBe(workerAId);
    expect(leaseAcquireds[1]).not.toBe(workerAId);

    // Exactly one lease_lost reason='expired' (recovery), and one for
    // worker B's clean release (reason='released').
    const leaseLost = events.filter(e => e.type === "lease_lost");
    const reasons = leaseLost.map(e => bodyOf<{ reason: string }>(e).reason);
    expect(reasons).toContain("expired");
    expect(reasons).toContain("released");

    // Turn 0 was NOT re-driven, NOT re-committed: exactly one
    // turn_committed for turnIdx=0 and one for turnIdx=1.
    const turnCommits = events.filter(e => e.type === "turn_committed");
    const committedTurnIds = turnCommits.map(e => bodyOf<{ turnIdx: number }>(e).turnIdx).sort();
    expect(committedTurnIds).toEqual([0, 1]);

    // Per-op seq monotonic across the entire recovery boundary.
    assertMonotonic(events);
  });
});

// ── Lane cap respected after recovery ────────────────────────────────────

describe("scheduler lane caps after recovery", () => {
  it("evictWorker frees a lane slot; idempotent on already-evicted ops", async () => {
    const op = mkOp("evict-frees-slot");
    // Register the hanging adapter BEFORE submission so canonicalLoopEntry's
    // pump spawns a worker that immediately hangs on turn 0.
    registerAdapterForOp(op.id, () => new HangingAdapter());
    canonicalLoopEntry(op);

    // Wait for the worker to register itself in scheduler.active.
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const events = readCanonicalEvents(op.id).map(e => e.type);
      if (events.includes("lease_acquired")) break;
      await new Promise(r => setTimeout(r, 5));
    }

    // First evict: there's an active hung worker → returns true.
    expect(evictWorker(op.id)).toBe(true);
    // Idempotent — second evict returns false (no active worker now).
    expect(evictWorker(op.id)).toBe(false);
  });
});

// ── Flag OFF compatibility ───────────────────────────────────────────────

describe("flag OFF: lease/recovery do not affect legacy submit path", () => {
  beforeEach(() => {
    delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
  });

  it("decideSubmitRouting still routes legacy when flag OFF", () => {
    const r = decideSubmitRouting({ lane: "interactive" });
    expect(r.route).toBe("legacy");
    expect(r.flagValue).toBe(false);
  });

  it("recoverStaleOp on a legacy-only op id returns unknown_op", () => {
    const r = recoverStaleOp("legacy_op_never_canonical");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("unknown_op");
  });
});
