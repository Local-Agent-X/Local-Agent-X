/**
 * Issue 07 — opRedirect (latest-wins at turn boundary).
 * docs/issues/canonical-loop/06-redirect-latest-wins.md (PRD §13)
 *
 * Acceptance covered:
 *   PRD test #5 — redirect mid-turn applied at next turn; redirect_applied
 *     emitted with same instructionId; redirect_instruction cleared;
 *     op_turns.redirectConsumed === true.
 *   PRD test #6 — two redirects in quick succession: latest-wins; only one
 *     redirect_applied for the second; both redirect_received events
 *     persisted.
 *   Edge — redirect immediately after submission, before any turn runs.
 *   Edge — redirect after pause but before resume; survives the pause
 *     and applies on the first resumed turn.
 *   Cancel-overrides-redirect — redirect set, then cancel; redirect not
 *     applied (no redirect_applied event), op cancels.
 *   Public API surface — invalid_op_id / unknown_op / invalid_instruction /
 *     terminal.
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
  opRedirect,
  opPause,
  opResume,
  opCancel,
  subscribeOpEvents,
  subscribeOpStream,
  subscribeOpSignals,
  readCanonicalEvents,
  readOpTurn,
  type CanonicalEvent,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";

import { FakeAdapter, scriptTurn, scriptMultiTurn, scriptLongStreamingTurn } from "./canonical-loop/fake-adapter.js";

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
    id: track(newOpId(`it07_${label}`)),
    type: "freeform",
    task: `issue-07 ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-07",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitState(opId: string, target: "paused" | "succeeded" | "cancelled" | "queued", timeoutMs = 3_000): Promise<void> {
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

// ── PRD test #5 — Redirect at next turn boundary ─────────────────────────

describe("Issue 07 — redirect at next turn boundary (PRD test #5)", () => {
  it("folds the instruction into the next turn, emits redirect_applied with same instructionId, clears column", async () => {
    const op = mkOp("happy-redirect");
    // Two-turn adapter: turn 0 streams (gives us a window for opRedirect),
    // turn 1 terminates.
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["s1", "s2", "s3"], text: "turn 0" },
        { text: "turn 1 (after redirect)", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    // Send the redirect during turn 0's stream.
    let redirected = false;
    const off = subscribeOpEvents(op.id, e => {
      if (e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 0 && !redirected) {
        redirected = true;
        const r = opRedirect(op.id, "follow this new direction", "test-actor");
        expect(r.ok).toBe(true);
      }
    });

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    off();

    const events = readCanonicalEvents(op.id);
    assertMonotonic(events);

    // ── Required events ──
    const received = events.filter(e => e.type === "redirect_received");
    const applied = events.filter(e => e.type === "redirect_applied");
    expect(received).toHaveLength(1);
    expect(applied).toHaveLength(1);

    const recvId = bodyOf<{ instructionId: string }>(received[0]).instructionId;
    const applId = bodyOf<{ instructionId: string }>(applied[0]).instructionId;
    expect(applId).toBe(recvId);

    // redirect_applied carries the turn index where it was folded in.
    expect(bodyOf<{ turnIdx: number }>(applied[0]).turnIdx).toBe(1);

    // Adapter received the redirect on turn 1 only — turn 0 had none.
    expect(adapter.turnInputs).toHaveLength(2);
    expect(adapter.turnInputs[0].pendingRedirect).toBeUndefined();
    expect(adapter.turnInputs[1].pendingRedirect?.text).toBe("follow this new direction");
    expect(adapter.turnInputs[1].pendingRedirect?.instructionId).toBe(recvId);

    // op_turns row for turn 1 records the consumption; turn 0 does not.
    expect(readOpTurn(op.id, 0)?.redirectConsumed).toBe(false);
    expect(readOpTurn(op.id, 1)?.redirectConsumed).toBe(true);

    // Redirect column cleared after applying.
    expect(readOp(op.id)?.canonical?.redirectInstruction ?? null).toBeNull();
    expect(readOp(op.id)?.canonical?.redirectReceivedAt ?? null).toBeNull();
  });
});

// ── PRD test #6 — Latest-wins ────────────────────────────────────────────

describe("Issue 07 — latest-wins (PRD test #6)", () => {
  it("two redirects in quick succession: only the second is applied; one redirect_applied", async () => {
    const op = mkOp("latest-wins");
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["a", "b", "c"], text: "turn 0" },
        { text: "turn 1 (after redirect)", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    let firstSent = false;
    const off = subscribeOpEvents(op.id, e => {
      if (e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 0 && !firstSent) {
        firstSent = true;
        const r1 = opRedirect(op.id, "first instruction", "actor-1");
        const r2 = opRedirect(op.id, "second instruction", "actor-2");
        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
      }
    });

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    off();

    const events = readCanonicalEvents(op.id);
    assertMonotonic(events);

    // ── Audit: TWO redirect_received (one per call) ──
    const received = events.filter(e => e.type === "redirect_received");
    expect(received).toHaveLength(2);
    const firstId = bodyOf<{ instructionId: string }>(received[0]).instructionId;
    const secondId = bodyOf<{ instructionId: string }>(received[1]).instructionId;
    expect(firstId).not.toBe(secondId);

    // ── Exactly ONE redirect_applied — for the SECOND id ──
    const applied = events.filter(e => e.type === "redirect_applied");
    expect(applied).toHaveLength(1);
    expect(bodyOf<{ instructionId: string }>(applied[0]).instructionId).toBe(secondId);

    // First instructionId never re-emitted on redirect_applied.
    const appliedIds = applied.map(e => bodyOf<{ instructionId: string }>(e).instructionId);
    expect(appliedIds).not.toContain(firstId);

    // Adapter saw only the second instruction folded in (latest-wins).
    expect(adapter.turnInputs[1].pendingRedirect?.text).toBe("second instruction");
    expect(adapter.turnInputs[1].pendingRedirect?.instructionId).toBe(secondId);

    // Column cleared after consume.
    expect(readOp(op.id)?.canonical?.redirectInstruction ?? null).toBeNull();
  });
});

// ── Edge — redirect before any turn runs ─────────────────────────────────

describe("Issue 07 — redirect before first turn", () => {
  it("a redirect set immediately after submission is folded into turn 0", async () => {
    const op = mkOp("pre-turn-redirect");
    const adapter = new FakeAdapter({
      script: [scriptTurn({ text: "turn 0 with redirect", terminal: "done" })],
    });
    registerAdapterForOp(op.id, () => adapter);

    canonicalLoopEntry(op);
    // Synchronous opRedirect lands BEFORE the worker's microtask launches
    // its first turn — same submit-then-control-call pattern as Issue 06's
    // pre-lease cancel.
    const r = opRedirect(op.id, "apply on first turn", "early-actor");
    expect(r.ok).toBe(true);

    await awaitTerminal(op.id);

    const events = readCanonicalEvents(op.id);
    const applied = events.filter(e => e.type === "redirect_applied");
    expect(applied).toHaveLength(1);
    expect(bodyOf<{ turnIdx: number }>(applied[0]).turnIdx).toBe(0);

    expect(adapter.turnInputs[0].pendingRedirect?.text).toBe("apply on first turn");
    expect(readOpTurn(op.id, 0)?.redirectConsumed).toBe(true);
    expect(readOp(op.id)?.canonical?.redirectInstruction ?? null).toBeNull();
  });
});

// ── Edge — redirect survives pause and applies after resume ──────────────

describe("Issue 07 — redirect survives pause→resume", () => {
  it("redirect set after pause is folded into the first turn after resume", async () => {
    const op = mkOp("redirect-across-pause");
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["x"], text: "turn 0" },
        { text: "turn 1 (after resume)", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    // Pause during turn 0 so the worker exits cleanly at the boundary.
    const off = subscribeOpEvents(op.id, e => {
      if (e.type === "turn_started" && (e.body as { turnIdx?: number }).turnIdx === 0) {
        opPause(op.id, "pre-redirect-pause");
      }
    });
    canonicalLoopEntry(op);
    await awaitState(op.id, "paused");
    off();

    // Set redirect WHILE paused — must survive the pause→resume cycle.
    const r = opRedirect(op.id, "after pause", "paused-actor");
    expect(r.ok).toBe(true);
    // Redirect persisted on disk through the pause.
    expect(readOp(op.id)?.canonical?.redirectInstruction?.text).toBe("after pause");

    // Resume.
    expect(opResume(op.id, "resumer").ok).toBe(true);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

    // Adapter saw the redirect on turn 1.
    expect(adapter.turnInputs[1].pendingRedirect?.text).toBe("after pause");

    // Exactly one redirect_applied, for turn 1.
    const events = readCanonicalEvents(op.id);
    const applied = events.filter(e => e.type === "redirect_applied");
    expect(applied).toHaveLength(1);
    expect(bodyOf<{ turnIdx: number }>(applied[0]).turnIdx).toBe(1);

    // Column cleared.
    expect(readOp(op.id)?.canonical?.redirectInstruction ?? null).toBeNull();
  });
});

// ── Cancel-overrides-redirect ────────────────────────────────────────────

describe("Issue 07 — cancel beats redirect (PRD §13 precedence)", () => {
  it("redirect set then cancel: op cancels with no redirect_applied event", async () => {
    const op = mkOp("cancel-beats-redirect");
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);

    const firstChunk = new Promise<void>((resolve) => {
      const off = subscribeOpStream(op.id, () => { off(); resolve(); });
    });

    canonicalLoopEntry(op);
    await firstChunk;

    // Both signals land while turn 0 is mid-stream.
    expect(opRedirect(op.id, "ignored", "r-actor").ok).toBe(true);
    expect(opCancel(op.id, "c-actor").ok).toBe(true);

    await awaitState(op.id, "cancelled");

    const events = readCanonicalEvents(op.id);
    // redirect_received WAS recorded — it's a control-API event, recorded
    // even when the op subsequently cancels.
    expect(events.some(e => e.type === "redirect_received")).toBe(true);
    // BUT redirect_applied is NEVER emitted — the next turn never runs.
    expect(events.some(e => e.type === "redirect_applied")).toBe(false);

    // No turn was ever committed (turn 0 was aborted mid-stream).
    expect(events.some(e => e.type === "turn_committed")).toBe(false);

    // Op finished cancelled, not succeeded.
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");
  });
});

// ── Bus signal publish ───────────────────────────────────────────────────

describe("Issue 07 — opRedirect publishes a fast-path signal", () => {
  it("publishes a RedirectSignal with kind='redirect' on op_signals:{opId}", () => {
    const op = mkOp("signal-bus");
    canonicalLoopEntry(op);

    const received: Array<{ kind: string; opId: string; instructionId?: string }> = [];
    const off = subscribeOpSignals(op.id, s => {
      received.push({
        kind: s.kind,
        opId: s.opId,
        instructionId: s.kind === "redirect" ? s.instructionId : undefined,
      });
    });
    const r = opRedirect(op.id, "via-bus", "actor");
    off();

    expect(r.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("redirect");
    expect(received[0].opId).toBe(op.id);
    expect(received[0].instructionId).toBeTruthy();
  });
});

// ── Public API negative cases ────────────────────────────────────────────

describe("Issue 07 — opRedirect error envelopes", () => {
  it("returns invalid_op_id for empty string", () => {
    const r = opRedirect("", "instruction", "actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_op_id");
  });

  it("returns invalid_instruction for empty instruction", () => {
    const op = mkOp("invalid-instr");
    canonicalLoopEntry(op);
    const r = opRedirect(op.id, "", "actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_instruction");
  });

  it("returns unknown_op for an op id that doesn't exist", () => {
    const r = opRedirect("op_does_not_exist_redirect", "instruction", "actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown_op");
  });

  it("returns terminal for already-succeeded ops", async () => {
    const op = mkOp("terminal-redirect");
    registerAdapterForOp(op.id, () => new FakeAdapter({
      script: [scriptTurn({ text: "ok", terminal: "done" })],
    }));
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

    const r = opRedirect(op.id, "too late", "late-actor");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("terminal");

    // No redirect_received emitted on terminal-rejection.
    const events = readCanonicalEvents(op.id);
    expect(events.some(e => e.type === "redirect_received")).toBe(false);
  });
});
