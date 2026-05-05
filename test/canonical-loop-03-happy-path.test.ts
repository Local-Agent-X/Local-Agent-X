/**
 * Issue 03 — Minimal canonical-loop happy path through `op_submit_async`
 * docs/issues/canonical-loop/03-happy-path-flag-on.md
 *
 * Acceptance covered:
 *   - PRD acceptance test #1 (single-turn happy path) with FakeAdapter.
 *   - Multi-turn happy path (3 turns, monotonic seq + turn_idx).
 *   - Happy path with a tool call dispatched through the canonical
 *     ToolDispatcher seam (the loop never executes tools itself).
 *   - Boundary checks: canonical-loop modules import no `child_process`;
 *     FakeAdapter has no DB / event-writer / worker-pool import.
 *   - Permanent invariant: `ops.state == latest state_changed.to` after
 *     every test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalLoopEntry,
  readCanonicalEvents,
  readLatestOpTurn,
  readOpMessages,
  readOpTurn,
  registerAdapterForOp,
  setDefaultAdapterForLane,
  resetCanonicalRuntime,
  resetScheduler,
  awaitIdle,
  setToolDispatcher,
  resetBus,
  streamChannel,
  getBus,
  type CanonicalEvent,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/workers/op-store.js";
import type { Op } from "../src/workers/types.js";

import { FakeAdapter, scriptTurn, scriptMultiTurn } from "./canonical-loop/fake-adapter.js";
import { FORBIDDEN_ADAPTER_IMPORTS } from "../src/canonical-loop/adapter-contract.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const trackedIds: string[] = [];
const track = <T extends string>(id: T): T => { trackedIds.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
});

afterEach(async () => {
  // Drain any in-flight workers before tearing down the on-disk op dirs.
  await awaitIdle(2_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  for (const id of trackedIds) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  trackedIds.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

// ── Helpers ──────────────────────────────────────────────────────────────

function mkOp(label: string, lane: Op["lane"] = "interactive"): Op {
  return {
    id: track(newOpId(`it03_${label}`)),
    type: "freeform",
    task: `issue-03 ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-03",
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
    const last = events.findLast?.(e => e.type === "state_changed")
      ?? [...events].reverse().find(e => e.type === "state_changed");
    const to = (last?.body as { to?: string } | null)?.to;
    if (to === "succeeded" || to === "failed" || to === "cancelled") return events;
    if (Date.now() > deadline) {
      const types = events.map(e => e.type).join(", ");
      throw new Error(`awaitTerminal timed out for ${opId} — events: [${types}]`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

function bodyOf<T>(e: CanonicalEvent): T {
  return (e.body ?? {}) as T;
}

function expectInvariant(opId: string): void {
  const events = readCanonicalEvents(opId);
  const lastStateChange = [...events].reverse().find(e => e.type === "state_changed");
  expect(lastStateChange, "no state_changed events").toBeDefined();
  const to = bodyOf<{ to: string }>(lastStateChange!).to;
  const op = readOp(opId);
  expect(op?.canonical?.state, "ops.state must equal latest state_changed.to").toBe(to);
}

function expectMonotonicSeq(events: CanonicalEvent[]): void {
  for (let i = 0; i < events.length; i++) {
    expect(events[i].seq, `seq mismatch at index ${i}`).toBe(i);
  }
}

// ── Single-turn happy path (PRD acceptance test #1) ──────────────────────

describe("Issue 03 — single-turn happy path (PRD #1)", () => {
  it("submit → running → succeeded; events monotonic; turn 0 committed", async () => {
    const op = mkOp("single");
    registerAdapterForOp(
      op.id,
      () => new FakeAdapter({ script: [scriptTurn({ text: "hello world", terminal: "done" })] }),
    );

    canonicalLoopEntry(op);
    const events = await awaitTerminal(op.id);

    // seq monotonic 0..N, no gaps
    expectMonotonicSeq(events);

    // Verify the locked event sequence for a single text-only turn (PRD §12).
    const types = events.map(e => e.type);
    expect(types).toEqual([
      "state_changed",   // null → queued
      "lease_acquired",
      "state_changed",   // queued → running
      "turn_started",
      "message_appended",
      "turn_committed",
      "state_changed",   // running → succeeded
      "lease_lost",
    ]);

    // state_changed bodies
    expect(bodyOf(events[0])).toMatchObject({ from: null, to: "queued" });
    expect(bodyOf(events[2])).toMatchObject({ from: "queued", to: "running" });
    expect(bodyOf(events[6])).toMatchObject({ from: "running", to: "succeeded" });

    // op_turns & op_messages populated
    const t0 = readOpTurn(op.id, 0);
    expect(t0?.terminalReason).toBe("done");
    expect(t0?.providerState.adapterName).toBe("fake");
    expect(readOpMessages(op.id)).toHaveLength(1);
    expect(readOpMessages(op.id)[0].role).toBe("assistant");

    // Denormalized cache matches MAX(op_turns.turn_idx)
    const persisted = readOp(op.id);
    expect(persisted?.canonical?.currentTurnIdx).toBe(0);
    expect(readLatestOpTurn(op.id)?.turnIdx).toBe(0);
    expect(persisted?.canonical?.state).toBe("succeeded");

    expectInvariant(op.id);
  });

  it("setDefaultAdapterForLane drives any op submitted on that lane", async () => {
    setDefaultAdapterForLane(
      "interactive",
      () => new FakeAdapter({ script: [scriptTurn({ text: "ok", terminal: "done" })] }),
    );
    const op = mkOp("default-lane");
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    expectInvariant(op.id);
  });

  it("stream_chunks ride op_stream:{opId} and are NOT persisted to op_events", async () => {
    const op = mkOp("stream");
    const captured: unknown[] = [];
    const off = getBus().subscribe(streamChannel(op.id), (msg) => captured.push(msg));
    registerAdapterForOp(
      op.id,
      () => new FakeAdapter({
        script: [scriptTurn({
          streamChunks: ["alpha", "bravo", "charlie"],
          text: "done",
          terminal: "done",
        })],
      }),
    );
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    off();

    expect(captured).toEqual(["alpha", "bravo", "charlie"]);
    // Stream chunks must not appear in canonical events.
    const events = readCanonicalEvents(op.id);
    expect(events.some(e => (e.type as string) === "stream_chunk")).toBe(false);
    expect(events.find(e => e.type === "message_appended")).toBeDefined();
    expectInvariant(op.id);
  });
});

// ── Multi-turn happy path ────────────────────────────────────────────────

describe("Issue 03 — multi-turn happy path", () => {
  it("3 sequential turns reach succeeded; turn_idx 0..2 with no gaps", async () => {
    const op = mkOp("multi");
    registerAdapterForOp(
      op.id,
      () => new FakeAdapter({
        script: scriptMultiTurn([
          { text: "step 1" },
          { text: "step 2" },
          { text: "step 3", terminal: "done" },
        ]),
      }),
    );
    canonicalLoopEntry(op);
    const events = await awaitTerminal(op.id);

    expectMonotonicSeq(events);

    // Three turn_started → three turn_committed pairs.
    const turnStarts = events.filter(e => e.type === "turn_started").map(e => bodyOf<{ turnIdx: number }>(e).turnIdx);
    const turnCommits = events.filter(e => e.type === "turn_committed").map(e => bodyOf<{ turnIdx: number }>(e).turnIdx);
    expect(turnStarts).toEqual([0, 1, 2]);
    expect(turnCommits).toEqual([0, 1, 2]);

    // op_turns 0..2 all present.
    expect(readOpTurn(op.id, 0)?.terminalReason).toBe(null);
    expect(readOpTurn(op.id, 1)?.terminalReason).toBe(null);
    expect(readOpTurn(op.id, 2)?.terminalReason).toBe("done");
    expect(readLatestOpTurn(op.id)?.turnIdx).toBe(2);

    // Denormalized cache matches MAX(op_turns.turn_idx).
    expect(readOp(op.id)?.canonical?.currentTurnIdx).toBe(2);

    expectInvariant(op.id);
  });
});

// ── Tool-call happy path ─────────────────────────────────────────────────

describe("Issue 03 — happy path with a tool call dispatched via the loop", () => {
  it("tool_started/tool_finished surround the dispatched call; tool_result persists in op_messages", async () => {
    const op = mkOp("tool");
    let dispatchCalls = 0;
    setToolDispatcher({
      async dispatch(call) {
        dispatchCalls++;
        return {
          toolCallId: call.toolCallId,
          status: "ok",
          result: { ok: true, echoed: call.args },
          durationMs: 7,
        };
      },
    });
    registerAdapterForOp(
      op.id,
      () => new FakeAdapter({
        script: scriptMultiTurn([
          { toolCalls: [{ toolCallId: "tc-1", tool: "search", args: { q: "lax" } }] },
          { text: "answer using tool result", terminal: "done" },
        ]),
      }),
    );
    canonicalLoopEntry(op);
    const events = await awaitTerminal(op.id);

    expectMonotonicSeq(events);
    expect(dispatchCalls).toBe(1);

    // tool_started AND tool_finished present, both targeting turn 0.
    const ts = events.find(e => e.type === "tool_started");
    const tf = events.find(e => e.type === "tool_finished");
    expect(ts).toBeDefined();
    expect(tf).toBeDefined();
    expect(bodyOf<{ turnIdx: number; tool: string }>(ts!)).toMatchObject({ turnIdx: 0, tool: "search" });
    expect(bodyOf<{ status: string }>(tf!)).toMatchObject({ status: "ok" });

    // Turn 0 committed with tool_call_summary; tool_result persisted in op_messages.
    const t0 = readOpTurn(op.id, 0);
    expect(t0?.toolCallSummary).toHaveLength(1);
    expect(t0?.toolCallSummary[0]).toMatchObject({ tool: "search", resultStatus: "ok" });
    const msgs = readOpMessages(op.id);
    const toolResult = msgs.find(m => m.role === "tool_result");
    expect(toolResult).toBeDefined();
    expect((toolResult!.content as { toolCallId: string }).toolCallId).toBe("tc-1");

    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    expectInvariant(op.id);
  });
});

// ── Boundary tests (PRD §15 sandbox + loop boundary) ─────────────────────

describe("Issue 03 — adapter / loop sandbox boundary", () => {
  const LOOP_DIR = join(process.cwd(), "src", "canonical-loop");

  function listLoopSourceFiles(): string[] {
    return readdirSync(LOOP_DIR)
      .filter(f => f.endsWith(".ts"))
      .map(f => join(LOOP_DIR, f));
  }

  it("canonical-loop modules import no child_process / node:child_process", () => {
    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of listLoopSourceFiles()) {
      const src = readFileSync(file, "utf-8");
      // Skip the sandbox deny-list constant in adapter-contract.ts — it's a
      // string literal, not an import statement.
      const stripped = src.replace(/FORBIDDEN_ADAPTER_IMPORTS[^;]+;/s, "");
      const re = /from\s+['"]([^'"]*child_process[^'"]*)['"]/;
      const match = stripped.match(re);
      if (match) offenders.push({ file, match: match[1] });
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it("FakeAdapter source contains none of the forbidden adapter imports", () => {
    const path = join(process.cwd(), "test", "canonical-loop", "fake-adapter.ts");
    const src = readFileSync(path, "utf-8");
    for (const f of FORBIDDEN_ADAPTER_IMPORTS) {
      const fromRe = new RegExp(`from\\s+['"][^'"]*${escapeRe(f)}[^'"]*['"]`);
      const reqRe = new RegExp(`require\\(\\s*['"][^'"]*${escapeRe(f)}[^'"]*['"]\\s*\\)`);
      expect(fromRe.test(src), `FakeAdapter has forbidden import: ${f}`).toBe(false);
      expect(reqRe.test(src), `FakeAdapter has forbidden import: ${f}`).toBe(false);
    }
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Missing-adapter fast-fail (Issue 03 blocker fix) ─────────────────────

describe("Issue 03 — flag ON + no adapter registered fails cleanly", () => {
  it("op transitions queued → failed and persists an adapter_error event", async () => {
    const op = mkOp("no-adapter");
    canonicalLoopEntry(op);

    // Synchronous contract preserved: state is still "queued" and only the
    // initial state_changed event has been written on the same task.
    expect(op.canonical?.state).toBe("queued");
    expect(readCanonicalEvents(op.id)).toHaveLength(1);

    // Microtask drains — fail-fast emits error + transitions to failed.
    const events = await awaitTerminal(op.id, 1_000);

    expectMonotonicSeq(events);

    // Locked sequence for this fast-fail path.
    expect(events.map(e => e.type)).toEqual([
      "state_changed", // null → queued
      "error",         // adapter_error
      "state_changed", // queued → failed
    ]);

    // adapter_error event body
    const err = events[1];
    expect(err.type).toBe("error");
    expect(bodyOf<{ code: string; retryable: boolean }>(err)).toMatchObject({
      code: "adapter_error",
      retryable: false,
    });

    // Final state on disk
    const persisted = readOp(op.id);
    expect(persisted?.canonical?.state).toBe("failed");
    expect(persisted?.status).toBe("failed");

    // Op is NOT stuck queued — terminal state reached.
    expect(bodyOf<{ to: string }>(events[2])).toMatchObject({
      from: "queued",
      to: "failed",
      reason: "adapter_not_configured",
    });

    expectInvariant(op.id);

    // Lifecycle artifacts: op never reached running, so no op_turns / op_messages.
    expect(readLatestOpTurn(op.id)).toBeNull();
    expect(readOpMessages(op.id)).toEqual([]);
  });

  it("op_submit_async response shape is unchanged on the missing-adapter path", () => {
    // canonicalLoopEntry returns void either way; the synchronous bookkeeping
    // it performs is byte-for-byte identical to the adapter-present case for
    // the sync window the caller observes (PRD §17 hard rule).
    const op = mkOp("shape-no-adapter");
    const ret = canonicalLoopEntry(op);
    expect(ret).toBeUndefined();
    expect(op.canonical?.flagValue).toBe(true);
    expect(op.canonical?.state).toBe("queued");
    expect(typeof op.id).toBe("string");
    expect(op.id.length).toBeGreaterThan(0);
  });
});

// ── Compatibility: legacy path stays unchanged when flag is OFF ──────────

describe("Issue 03 — legacy path untouched when flag OFF", () => {
  beforeEach(() => {
    delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
  });

  it("decideSubmitRouting returns legacy when flag OFF", async () => {
    const { decideSubmitRouting } = await import("../src/canonical-loop/index.js");
    const r = decideSubmitRouting({ lane: "interactive" });
    expect(r.route).toBe("legacy");
    expect(r.flagValue).toBe(false);
  });
});
