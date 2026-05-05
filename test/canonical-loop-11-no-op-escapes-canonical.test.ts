/**
 * Issue 11 — "no op escapes canonical" cutover invariant.
 * docs/issues/canonical-loop/11-v1-hardening-and-invariants.md (PRD §20)
 *
 * The post-deletion-gate invariant the PRD locks in forever:
 *
 *   After cutover, every op produced by `op_submit_async` must:
 *     - Have a row in `ops`.
 *     - Have at least one `op_turns` row, unless terminal-before-first-
 *       turn is explicitly represented (pre-lease cancel,
 *       adapter-not-configured fail-safe, etc.).
 *     - Have `op_events` rows with monotonic seq.
 *     - Have `ops.state` matching the latest `state_changed.to`.
 *     - Have touched no legacy execution write path.
 *
 * v1.0 ships behind a flag — the deletion gate has NOT been crossed
 * yet. This test exercises the invariant against the FLAG-ON path so
 * the post-cutover guarantee is provable today, on the canary opt-in
 * path. After the deletion-gate manifest items 1–10 land, the same
 * invariant runs unconditionally for every op.
 *
 * The test enumerates terminal scenarios the loop supports — succeeded,
 * failed, cancelled mid-stream, cancelled before lease — and asserts
 * each leaves the disk in a canonical-only state.
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
  readCanonicalEvents,
  readLatestOpTurn,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/workers/op-store.js";
import { opDir } from "../src/workers/event-log.js";
import type { Op } from "../src/workers/types.js";

import { FakeAdapter, scriptTurn, scriptLongStreamingTurn } from "./canonical-loop/fake-adapter.js";

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
    id: track(newOpId(`it11n_${label}`)),
    type: "freeform",
    task: `issue-11 no-escape ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-11-no-escape",
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

interface NoEscapeAssertion {
  /** When true, the op terminated before any turn committed (pre-lease cancel). */
  expectNoTurns?: boolean;
}

function assertNoOpEscapes(opId: string, opts: NoEscapeAssertion = {}): void {
  // (a) Op row on disk.
  const op = readOp(opId);
  expect(op, `op ${opId} missing on disk`).toBeTruthy();

  // (b) flag-ON capture: ops.canonical.flagValue must be true.
  expect(op?.canonical?.flagValue).toBe(true);

  // (c) State matches latest state_changed.to.
  const events = readCanonicalEvents(opId);
  expect(events.length).toBeGreaterThan(0);
  const stateChanges = events.filter(e => e.type === "state_changed");
  const latest = stateChanges[stateChanges.length - 1];
  expect((latest.body as { to?: string })?.to).toBe(op?.canonical?.state);

  // (d) Per-op seq monotonic 0..N.
  for (let i = 0; i < events.length; i++) {
    expect(events[i].seq, `op=${opId} seq ${events[i].seq} != ${i}`).toBe(i);
  }

  // (e) op_turns: at least one row UNLESS the op terminated before any
  //     turn (pre-lease cancel / adapter-not-configured fast-fail).
  const latestTurn = readLatestOpTurn(opId);
  if (opts.expectNoTurns) {
    expect(latestTurn, `op=${opId} expected no turns but found one`).toBeNull();
  } else {
    expect(latestTurn, `op=${opId} has no committed turn — should have at least one`).toBeTruthy();
  }

  // (f) No legacy events.jsonl was written. The legacy worker pool
  //     would write to `<opdir>/events.jsonl`; canonical writes to
  //     `<opdir>/canonical-events.jsonl`. Their separation is the
  //     post-cutover invariant: a canonical op never touches the
  //     legacy log.
  const legacyEventsPath = join(opDir(opId), "events.jsonl");
  expect(existsSync(legacyEventsPath), `op=${opId} touched legacy events.jsonl`).toBe(false);
}

// ── Terminal scenarios under flag ON ────────────────────────────────────

describe("Issue 11 — flag ON: every op produces canonical artifacts only", () => {
  it("succeeded op leaves canonical artifacts and zero legacy artifacts", async () => {
    const op = mkOp("succeeded");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "ok", terminal: "done" })],
    }));
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    assertNoOpEscapes(op.id);
  });

  it("failed op (adapter terminal=error) leaves canonical artifacts and zero legacy artifacts", async () => {
    const op = mkOp("failed");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({
        errorReports: [{ code: "synthetic", message: "synth", retryable: false }],
        terminal: "error",
      })],
    }));
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("failed");
    assertNoOpEscapes(op.id);
  });

  it("cancelled mid-stream op: state=cancelled, no turn committed, no legacy log", async () => {
    const op = mkOp("cancelled");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    }));
    canonicalLoopEntry(op);
    await new Promise(r => setTimeout(r, 50));
    expect(opCancel(op.id, "no-escape").ok).toBe(true);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");
    assertNoOpEscapes(op.id, { expectNoTurns: true });
  });

  it("pre-lease cancelled op: queued → cancelled, no turns, no legacy log", async () => {
    const op = mkOp("pre-lease");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "should never run", terminal: "done" })],
    }));
    canonicalLoopEntry(op);
    expect(opCancel(op.id, "early").ok).toBe(true);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");
    assertNoOpEscapes(op.id, { expectNoTurns: true });
  });
});

// ── Permanent invariant test (PRD §20) — no op writes to legacy AND ────
// canonical at the same time ─────────────────────────────────────────────

describe("Issue 11 — canonical artifacts and legacy artifacts are disjoint per op (flag ON)", () => {
  it("flag ON: legacy `events.jsonl` is never created at any point in the op's lifecycle", async () => {
    const op = mkOp("disjoint");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "disjoint check", terminal: "done" })],
    }));
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    // Sweep the op directory for any legacy artifact.
    const legacyEventsPath = join(opDir(op.id), "events.jsonl");
    expect(existsSync(legacyEventsPath)).toBe(false);
  });
});
