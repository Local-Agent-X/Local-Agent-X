/**
 * Issue 01 — Schema additions + feature flag compatibility skeleton.
 * docs/issues/canonical-loop/01-schema-and-flag-skeleton.md
 *
 * Acceptance covered here:
 *   - Migration up/down test (schema/store layer exists, idempotent setup).
 *   - Snapshot fixture test for op_submit_async with flag OFF (unchanged shape).
 *   - Smoke test: flag ON writes the canonical state_changed skeleton event,
 *     captures op.canonical.flagValue, and writes nothing to legacy
 *     execution tables.
 *   - Sanity: legacy queries on Op still work with new fields present.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { writeOp, readOp, newOpId } from "../src/workers/op-store.js";
import { readEvents } from "../src/workers/event-log.js";
import type { Op } from "../src/workers/types.js";
import {
  isCanonicalLoopEnabled,
  envVarForLane,
  decideSubmitRouting,
  canonicalLoopEntry,
  appendCanonicalEvent,
  readCanonicalEvents,
  readCanonicalEventsSince,
  insertOpTurn,
  readLatestOpTurn,
  readOpTurn,
  appendOpMessage,
  readOpMessages,
  canonicalEventsPath,
  opTurnPath,
  opMessagesPath,
} from "../src/canonical-loop/index.js";
import type { OpTurnRow, OpMessageRow } from "../src/canonical-loop/index.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const LANE_ENVS = [
  "LAX_CANONICAL_LOOP_INTERACTIVE",
  "LAX_CANONICAL_LOOP_BUILD",
  "LAX_CANONICAL_LOOP_IDE",
  "LAX_CANONICAL_LOOP_BACKGROUND",
  "LAX_CANONICAL_LOOP_ALL",
];

let counter = 0;
const opId = (label: string) => `cltest_${Date.now().toString(36)}_${++counter}_${label}`;

const createdIds: string[] = [];
const track = (id: string) => { createdIds.push(id); return id; };

const mkOp = (id: string, over: Partial<Op> = {}): Op => ({
  id,
  type: over.type ?? "freeform",
  task: over.task ?? "do the thing",
  contextPack: over.contextPack ?? ({} as Op["contextPack"]),
  lane: over.lane ?? "interactive",
  retryPolicy: over.retryPolicy ?? { maxRecoveryAttempts: 3, backoffMs: [5_000] },
  ownerId: over.ownerId ?? "u",
  visibility: over.visibility ?? "private",
  status: over.status ?? "pending",
  createdAt: over.createdAt ?? new Date().toISOString(),
  attemptCount: over.attemptCount ?? 0,
  ...over,
});

beforeEach(() => {
  for (const e of LANE_ENVS) delete process.env[e];
});

afterEach(() => {
  for (const id of createdIds) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  createdIds.length = 0;
  for (const e of LANE_ENVS) delete process.env[e];
});

// ── Feature-flag reader ───────────────────────────────────────────────────

describe("isCanonicalLoopEnabled — env-driven, lane-keyed, default OFF", () => {
  it("defaults OFF for every lane when no env is set", () => {
    expect(isCanonicalLoopEnabled("interactive")).toBe(false);
    expect(isCanonicalLoopEnabled("build")).toBe(false);
    expect(isCanonicalLoopEnabled("ide")).toBe(false);
    expect(isCanonicalLoopEnabled("background")).toBe(false);
  });

  it("turns ON only the lane whose env var is truthy", () => {
    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
    expect(isCanonicalLoopEnabled("interactive")).toBe(true);
    expect(isCanonicalLoopEnabled("build")).toBe(false);
    expect(isCanonicalLoopEnabled("ide")).toBe(false);
    expect(isCanonicalLoopEnabled("background")).toBe(false);
  });

  it("accepts canonical truthy values: 1, true, yes, on (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "YES", "on", "ON"]) {
      process.env.LAX_CANONICAL_LOOP_BUILD = v;
      expect(isCanonicalLoopEnabled("build")).toBe(true);
    }
  });

  it("treats any non-truthy value as OFF", () => {
    for (const v of ["0", "false", "no", "off", "", " ", "maybe"]) {
      process.env.LAX_CANONICAL_LOOP_BUILD = v;
      expect(isCanonicalLoopEnabled("build")).toBe(false);
    }
  });

  it("LAX_CANONICAL_LOOP_ALL flips every lane ON regardless of per-lane env", () => {
    process.env.LAX_CANONICAL_LOOP_ALL = "1";
    expect(isCanonicalLoopEnabled("interactive")).toBe(true);
    expect(isCanonicalLoopEnabled("build")).toBe(true);
    expect(isCanonicalLoopEnabled("ide")).toBe(true);
    expect(isCanonicalLoopEnabled("background")).toBe(true);
  });

  it("envVarForLane maps each lane to its documented env name", () => {
    expect(envVarForLane("interactive")).toBe("LAX_CANONICAL_LOOP_INTERACTIVE");
    expect(envVarForLane("build")).toBe("LAX_CANONICAL_LOOP_BUILD");
    expect(envVarForLane("ide")).toBe("LAX_CANONICAL_LOOP_IDE");
    expect(envVarForLane("background")).toBe("LAX_CANONICAL_LOOP_BACKGROUND");
  });
});

// ── Routing decision ──────────────────────────────────────────────────────

describe("decideSubmitRouting — pure routing decision at submit time", () => {
  it("flag OFF → legacy route, flagValue=false", () => {
    const r = decideSubmitRouting({ lane: "interactive" });
    expect(r.route).toBe("legacy");
    expect(r.flagValue).toBe(false);
    expect(r.lane).toBe("interactive");
  });

  it("flag ON for interactive → canonical route, flagValue=true", () => {
    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
    const r = decideSubmitRouting({ lane: "interactive" });
    expect(r.route).toBe("canonical");
    expect(r.flagValue).toBe(true);
  });

  it("per-lane isolation — interactive ON does not affect build", () => {
    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
    expect(decideSubmitRouting({ lane: "interactive" }).route).toBe("canonical");
    expect(decideSubmitRouting({ lane: "build" }).route).toBe("legacy");
  });
});

// ── Schema/store layer (Issue 01: "all four new tables exist") ────────────

describe("canonical store — append-only writers/readers exist and behave", () => {
  it("appendCanonicalEvent assigns monotonic per-op seq starting at 0", () => {
    const id = track(opId("seq"));
    const e0 = appendCanonicalEvent(id, "state_changed", { from: null, to: "queued", reason: "submitted" });
    const e1 = appendCanonicalEvent(id, "lease_acquired", { workerId: "w-1" });
    const e2 = appendCanonicalEvent(id, "turn_started", { turn_idx: 0 });
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    const all = readCanonicalEvents(id);
    expect(all.map(e => e.seq)).toEqual([0, 1, 2]);
    expect(all.map(e => e.type)).toEqual(["state_changed", "lease_acquired", "turn_started"]);
  });

  it("readCanonicalEvents returns empty array when no events exist", () => {
    const id = track(opId("empty"));
    expect(readCanonicalEvents(id)).toEqual([]);
  });

  it("readCanonicalEventsSince filters by seq strictly greater-than", () => {
    const id = track(opId("since"));
    appendCanonicalEvent(id, "state_changed", null);
    appendCanonicalEvent(id, "turn_started", null);
    appendCanonicalEvent(id, "turn_committed", null);
    expect(readCanonicalEventsSince(id, -1).map(e => e.seq)).toEqual([0, 1, 2]);
    expect(readCanonicalEventsSince(id, 0).map(e => e.seq)).toEqual([1, 2]);
    expect(readCanonicalEventsSince(id, 2)).toEqual([]);
    expect(readCanonicalEventsSince(id, 99)).toEqual([]);
  });

  it("per-op seq is independent across different ops (no cross-talk)", () => {
    const a = track(opId("iso-a"));
    const b = track(opId("iso-b"));
    appendCanonicalEvent(a, "state_changed", null);
    appendCanonicalEvent(a, "turn_started", null);
    appendCanonicalEvent(b, "state_changed", null);
    expect(readCanonicalEvents(a).map(e => e.seq)).toEqual([0, 1]);
    expect(readCanonicalEvents(b).map(e => e.seq)).toEqual([0]);
  });

  it("op_turns insert is idempotent on PK (op_id, turn_idx) — second insert returns false", () => {
    const id = track(opId("turns"));
    const row: OpTurnRow = {
      opId: id,
      turnIdx: 0,
      providerState: { adapterName: "fake", adapterVersion: "0.0.0", providerPayload: {} },
      toolCallSummary: [],
      terminalReason: null,
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
    };
    expect(insertOpTurn(row)).toBe(true);
    expect(insertOpTurn(row)).toBe(false);
    expect(readOpTurn(id, 0)).not.toBeNull();
    expect(readLatestOpTurn(id)?.turnIdx).toBe(0);
  });

  it("readLatestOpTurn picks the highest turn_idx, not the most recently written", () => {
    const id = track(opId("turn-max"));
    const base: Omit<OpTurnRow, "turnIdx"> = {
      opId: id,
      providerState: { adapterName: "fake", adapterVersion: "0.0.0", providerPayload: {} },
      toolCallSummary: [],
      terminalReason: null,
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
    };
    insertOpTurn({ ...base, turnIdx: 2 });
    insertOpTurn({ ...base, turnIdx: 0 });
    insertOpTurn({ ...base, turnIdx: 1 });
    expect(readLatestOpTurn(id)?.turnIdx).toBe(2);
  });

  it("op_messages append-only round-trip", () => {
    const id = track(opId("msgs"));
    const m: OpMessageRow = {
      messageId: "m-1",
      opId: id,
      turnIdx: 0,
      seqInTurn: 0,
      role: "user",
      content: { text: "hi" },
      createdAt: new Date().toISOString(),
    };
    appendOpMessage(m);
    expect(readOpMessages(id)).toHaveLength(1);
    expect(readOpMessages(id)[0].messageId).toBe("m-1");
  });

  it("paths land under ~/.lax/operations/<opId>/ — additive only, nothing outside", () => {
    const id = track(opId("paths"));
    appendCanonicalEvent(id, "state_changed", null);
    expect(canonicalEventsPath(id)).toContain(join(".lax", "operations", id));
    expect(opTurnPath(id, 0)).toContain(join("op-turns", "0.json"));
    expect(opMessagesPath(id)).toContain("op-messages.jsonl");
    expect(existsSync(canonicalEventsPath(id))).toBe(true);
  });
});

// ── canonicalLoopEntry — Issue 01 skeleton write ──────────────────────────

describe("canonicalLoopEntry — Issue 01 skeleton", () => {
  it("captures flagValue=true and canonical state='queued' on the op", () => {
    const op = mkOp(track(opId("entry")));
    canonicalLoopEntry(op);
    expect(op.canonical?.flagValue).toBe(true);
    expect(op.canonical?.state).toBe("queued");
  });

  it("initializes all PRD §9 additive ops columns to null (or set value)", () => {
    const op = mkOp(track(opId("nulls")), { lane: "interactive" });
    canonicalLoopEntry(op, { sessionId: "sess-1" });
    expect(op.canonical?.leaseOwner).toBeNull();
    expect(op.canonical?.leaseExpiresAt).toBeNull();
    expect(op.canonical?.pauseRequestedAt).toBeNull();
    expect(op.canonical?.cancelRequestedAt).toBeNull();
    expect(op.canonical?.redirectInstruction).toBeNull();
    expect(op.canonical?.redirectReceivedAt).toBeNull();
    expect(op.canonical?.currentTurnIdx).toBeNull();
    expect(op.canonical?.currentCheckpointId).toBeNull();
    expect(op.canonical?.sessionId).toBe("sess-1");
  });

  it("persists exactly one state_changed event with body {from:null,to:'queued',reason:'submitted'}", () => {
    const op = mkOp(track(opId("evt")));
    canonicalLoopEntry(op);
    const evts = readCanonicalEvents(op.id);
    expect(evts).toHaveLength(1);
    expect(evts[0].type).toBe("state_changed");
    expect(evts[0].seq).toBe(0);
    expect(evts[0].body).toEqual({ from: null, to: "queued", reason: "submitted" });
  });

  it("persists the op so readOp() can hydrate canonical fields", () => {
    const op = mkOp(track(opId("rt")));
    canonicalLoopEntry(op);
    const back = readOp(op.id);
    expect(back?.canonical?.flagValue).toBe(true);
    expect(back?.canonical?.state).toBe("queued");
  });

  it("does NOT write to the legacy events.jsonl on the canonical path", () => {
    const op = mkOp(track(opId("no-legacy")));
    canonicalLoopEntry(op);
    expect(readEvents(op.id)).toEqual([]);
  });
});

// ── Legacy compatibility (flag OFF, sanity) ──────────────────────────────

describe("legacy Op storage with new optional fields present", () => {
  it("Op without canonical sub-object round-trips through writeOp/readOp", () => {
    const id = track(opId("legacy-rt"));
    const op = mkOp(id);
    expect(op.canonical).toBeUndefined();
    writeOp(op);
    const back = readOp(id);
    expect(back).not.toBeNull();
    expect(back!.id).toBe(id);
    expect(back!.canonical).toBeUndefined();
  });

  it("Op with canonical sub-object round-trips and preserves nested fields", () => {
    const id = track(opId("canon-rt"));
    const op = mkOp(id);
    op.canonical = {
      flagValue: true,
      state: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      pauseRequestedAt: null,
      cancelRequestedAt: null,
      redirectInstruction: null,
      redirectReceivedAt: null,
      currentTurnIdx: null,
      currentCheckpointId: null,
      sessionId: "sess-1",
    };
    writeOp(op);
    const back = readOp(id);
    expect(back?.canonical?.flagValue).toBe(true);
    expect(back?.canonical?.state).toBe("queued");
    expect(back?.canonical?.sessionId).toBe("sess-1");
  });

  it("a legacy op file (no `canonical` key) still loads cleanly with new types", () => {
    // Simulate an op written before Issue 01 — operation.json without canonical.
    const id = track(opId("pre-issue"));
    const op = mkOp(id, { status: "running" });
    delete (op as Partial<Op>).canonical;
    writeOp(op);
    const json = JSON.parse(readFileSync(join(OPS_BASE, id, "operation.json"), "utf-8"));
    expect(json).not.toHaveProperty("canonical");
    expect(readOp(id)?.status).toBe("running");
  });
});

// ── Snapshot fixture stand-in for op_submit_async surfaces ────────────────
// We don't call op_submit_async.execute() here (it would spawn workers).
// Instead we lock the response-shape contract: routing produces an Op that
// serializes consistently; canonical and legacy paths have indistinguishable
// op shape on disk except for the additive `canonical` sub-object.

describe("op_submit_async — flag OFF vs ON shape parity (Issue 01 acceptance #11 partial)", () => {
  it("flag OFF: op persisted has no `canonical` field — byte-additive only", () => {
    const id = track(opId("off-shape"));
    const op = mkOp(id, { lane: "interactive" });
    const r = decideSubmitRouting(op);
    expect(r.route).toBe("legacy");
    expect(r.flagValue).toBe(false);
    // Legacy path would call submitOp(op); we only verify the router decision
    // and that no canonical fields were attached.
    expect(op.canonical).toBeUndefined();
    writeOp(op);
    expect(existsSync(canonicalEventsPath(id))).toBe(false);
  });

  it("flag ON: op persisted gets canonical.flagValue=true and one state_changed row", () => {
    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
    const id = track(opId("on-shape"));
    const op = mkOp(id, { lane: "interactive" });
    const r = decideSubmitRouting(op);
    expect(r.route).toBe("canonical");
    expect(r.flagValue).toBe(true);
    canonicalLoopEntry(op);
    const back = readOp(id);
    expect(back?.canonical?.flagValue).toBe(true);
    expect(back?.id).toBe(id);
    expect(back?.task).toBe(op.task); // non-canonical fields unchanged
    expect(back?.lane).toBe("interactive");
    expect(readCanonicalEvents(id)).toHaveLength(1);
    // No legacy event-log writes.
    expect(readEvents(id)).toEqual([]);
  });
});
