/**
 * Durable pending-approval substrate (control-api-approvals.ts +
 * approval-manager bridge).
 *
 * Covers:
 *   - signal-column round-trip: recordApprovalRequested write → a worker's
 *     persistOpKeepingSignals RMW does not clobber the column
 *   - approval_requested / approval_resolved append + replay via opEventsSince
 *   - opResolveApproval live path (delivered) and not-live path (recorded)
 *   - approval-manager writes the column on ask and clears it on
 *     approve / deny / timeout / superseded, with the right reason
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { ServerEvent } from "../types.js";

// op-store binds OPS_BASE = join(getLaxDir(), …) at import, so the env
// override must be in place BEFORE the dynamic imports below.
const prevLaxDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-approvals-"));
process.env.LAX_DATA_DIR = dataDir;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const {
  recordApprovalRequested,
  recordApprovalResolved,
  opResolveApproval,
  opEventsSince,
  persistOpKeepingSignals,
  OP_EVENTS_FROM_BEGINNING,
} = await import("./index.js");
const { writeOp, readOp } = await import("../ops/op-store.js");
const { getApprovalManager } = await import("../approval-manager.js");

const APPROVAL_TIMEOUT_MS = 5 * 60_000; // mirrors approval-manager.ts

let seq = 0;
const uid = (label: string) => `${label}-${++seq}-${process.hrtime.bigint().toString(36)}`;

const mkOp = (id: string, over: Partial<Op> = {}): Op => ({
  id,
  type: "freeform",
  task: "do the thing",
  contextPack: {} as Op["contextPack"],
  lane: "interactive" as Op["lane"],
  retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
  ownerId: "u",
  visibility: "private" as Op["visibility"],
  status: "pending" as Op["status"],
  createdAt: new Date().toISOString(),
  attemptCount: 0,
  ...over,
});

const record = (approvalId: string, toolName = "bash") => ({
  approvalId,
  toolName,
  toolCallId: "tc-1",
  argsPreview: `{"command":"rm -rf build"}`,
  context: "irreversible",
  requestedAt: Date.now(),
});

function eventsOf(opId: string, type?: string) {
  const res = opEventsSince(opId, OP_EVENTS_FROM_BEGINNING);
  if (!res.ok) throw new Error(`opEventsSince failed: ${res.code}`);
  return type ? res.events.filter(e => e.type === type) : res.events;
}

/** Ask through the REAL manager with an opId, waiting until the card exists. */
async function askOpScoped(opId: string, sessionId: string, extra: { toolName?: string } = {}) {
  const events: ServerEvent[] = [];
  let approvalId = "";
  let sawCard: () => void = () => {};
  const cardSeen = new Promise<void>(res => { sawCard = res; });
  const outcome = getApprovalManager().requestApprovalDetailed({
    toolName: extra.toolName ?? "bash",
    toolCallId: "tc-1",
    sessionId,
    context: "test ask",
    args: { command: `echo ${sessionId}` },
    alwaysAsk: true,
    opId,
    emit: (e) => {
      events.push(e);
      if (e.type === "approval_requested") { approvalId = e.approvalId; sawCard(); }
    },
  });
  await cardSeen;
  return { outcome, events, approvalId: () => approvalId };
}

describe("pendingApproval signal column", () => {
  it("recordApprovalRequested writes the column and appends approval_requested", () => {
    const opId = uid("op-write");
    writeOp(mkOp(opId));
    const rec = record("apr-a", "delete_file");
    recordApprovalRequested(opId, rec);

    expect(readOp(opId)?.canonical?.pendingApproval).toEqual(rec);
    const evs = eventsOf(opId, "approval_requested");
    expect(evs).toHaveLength(1);
    expect(evs[0].body).toEqual({ approvalId: "apr-a", toolName: "delete_file" });
  });

  it("survives a worker persistOpKeepingSignals RMW from a stale in-memory op", () => {
    const opId = uid("op-rmw");
    writeOp(mkOp(opId));
    const rec = record("apr-b");
    recordApprovalRequested(opId, rec);

    // Loop-side write from an op object that never saw the approval column.
    persistOpKeepingSignals(mkOp(opId, { status: "running", canonical: { state: "running" } }));

    const onDisk = readOp(opId);
    expect(onDisk?.status).toBe("running");
    expect(onDisk?.canonical?.pendingApproval).toEqual(rec);
  });

  it("recordApprovalResolved clears the column only for the matching approvalId", () => {
    const opId = uid("op-clear");
    writeOp(mkOp(opId));
    recordApprovalRequested(opId, record("apr-old"));
    recordApprovalRequested(opId, record("apr-new")); // latest-wins overwrite

    // Stale resolution for the superseded card must NOT clobber the new one.
    recordApprovalResolved(opId, { approvalId: "apr-old", toolName: "bash", approved: false, reason: "timeout" });
    expect(readOp(opId)?.canonical?.pendingApproval?.approvalId).toBe("apr-new");

    recordApprovalResolved(opId, { approvalId: "apr-new", toolName: "bash", approved: true });
    expect(readOp(opId)?.canonical?.pendingApproval).toBeNull();

    const resolved = eventsOf(opId, "approval_resolved");
    expect(resolved.map(e => e.body)).toEqual([
      { approvalId: "apr-old", toolName: "bash", approved: false, reason: "timeout" },
      { approvalId: "apr-new", toolName: "bash", approved: true },
    ]);
  });

  it("no-ops for an unknown op (non-op-scoped asks have no durable shadow)", () => {
    expect(() => recordApprovalRequested("no-such-op", record("apr-x"))).not.toThrow();
    expect(() => recordApprovalResolved("no-such-op", { approvalId: "apr-x", toolName: "bash", approved: true })).not.toThrow();
  });
});

describe("opResolveApproval", () => {
  it("validates ids and rejects unknown ops / approvals", () => {
    expect(opResolveApproval("", "apr-1", true)).toMatchObject({ ok: false, code: "invalid_op_id" });
    expect(opResolveApproval("op-x", "", true)).toMatchObject({ ok: false, code: "invalid_approval_id" });
    expect(opResolveApproval("no-such-op", "apr-1", true)).toMatchObject({ ok: false, code: "unknown_op" });

    const opId = uid("op-noapproval");
    writeOp(mkOp(opId));
    expect(opResolveApproval(opId, "apr-none", true)).toMatchObject({ ok: false, code: "unknown_approval" });
  });

  it("not-live path: records the decision, clears the column, appends approval_resolved", () => {
    const opId = uid("op-notlive");
    writeOp(mkOp(opId));
    // Column exists on disk but no live card (post-restart shape).
    recordApprovalRequested(opId, record("apr-dead", "write_file"));

    const res = opResolveApproval(opId, "apr-dead", false);
    expect(res).toEqual({ ok: true, delivery: "recorded" });
    expect(readOp(opId)?.canonical?.pendingApproval).toBeNull();
    const resolved = eventsOf(opId, "approval_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].body).toEqual({
      approvalId: "apr-dead",
      toolName: "write_file",
      approved: false,
      reason: "declined",
    });

    // Second resolve of the same card: nothing pending anymore.
    expect(opResolveApproval(opId, "apr-dead", false)).toMatchObject({ ok: false, code: "unknown_approval" });
  });

  it("not-live approve carries approved:true and no reason", () => {
    const opId = uid("op-notlive-ok");
    writeOp(mkOp(opId));
    recordApprovalRequested(opId, record("apr-dead-ok"));
    expect(opResolveApproval(opId, "apr-dead-ok", true)).toEqual({ ok: true, delivery: "recorded" });
    expect(eventsOf(opId, "approval_resolved")[0].body).toEqual({
      approvalId: "apr-dead-ok",
      toolName: "bash",
      approved: true,
    });
  });

  it("live path: settles the waiting promise and the manager writes the durable clear", async () => {
    const opId = uid("op-live");
    writeOp(mkOp(opId));
    const sessionId = uid("sess-live");
    const ask = await askOpScoped(opId, sessionId);

    // Ask-side durable shadow landed before we resolve.
    const col = readOp(opId)?.canonical?.pendingApproval;
    expect(col?.approvalId).toBe(ask.approvalId());
    expect(col?.toolName).toBe("bash");
    expect(typeof col?.requestedAt).toBe("number");
    expect(col?.argsPreview).toContain(sessionId);

    const res = opResolveApproval(opId, ask.approvalId(), true);
    expect(res).toEqual({ ok: true, delivery: "delivered" });
    await expect(ask.outcome).resolves.toMatchObject({ approved: true });

    expect(readOp(opId)?.canonical?.pendingApproval).toBeNull();
    const types = eventsOf(opId).map(e => e.type);
    expect(types).toEqual(["approval_requested", "approval_resolved"]);
    expect(eventsOf(opId, "approval_resolved")[0].body).toEqual({
      approvalId: ask.approvalId(),
      toolName: "bash",
      approved: true,
    });
  });
});

describe("approval-manager durable settle bookkeeping", () => {
  it("deny click clears the column with reason declined", async () => {
    const opId = uid("op-deny");
    writeOp(mkOp(opId));
    const ask = await askOpScoped(opId, uid("sess-deny"));

    expect(getApprovalManager().resolveApproval(ask.approvalId(), false)).toBe(true);
    await expect(ask.outcome).resolves.toMatchObject({ approved: false, reason: "declined" });

    expect(readOp(opId)?.canonical?.pendingApproval).toBeNull();
    expect(eventsOf(opId, "approval_resolved")[0].body).toEqual({
      approvalId: ask.approvalId(),
      toolName: "bash",
      approved: false,
      reason: "declined",
    });
  });

  it("timeout clears the column with reason timeout", async () => {
    const opId = uid("op-timeout");
    writeOp(mkOp(opId));
    vi.useFakeTimers();
    try {
      const ask = await askOpScoped(opId, uid("sess-timeout"));
      expect(readOp(opId)?.canonical?.pendingApproval?.approvalId).toBe(ask.approvalId());

      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS + 1);
      await expect(ask.outcome).resolves.toMatchObject({ approved: false, reason: "timeout" });

      expect(readOp(opId)?.canonical?.pendingApproval).toBeNull();
      expect(eventsOf(opId, "approval_resolved")[0].body).toEqual({
        approvalId: ask.approvalId(),
        toolName: "bash",
        approved: false,
        reason: "timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("denyPendingForSession (user replied in chat) clears with reason superseded", async () => {
    const opId = uid("op-superseded");
    writeOp(mkOp(opId));
    const sessionId = uid("sess-superseded");
    const ask = await askOpScoped(opId, sessionId);

    expect(getApprovalManager().denyPendingForSession(sessionId)).toBe(1);
    await expect(ask.outcome).resolves.toMatchObject({ approved: false, reason: "superseded" });

    expect(readOp(opId)?.canonical?.pendingApproval).toBeNull();
    expect(eventsOf(opId, "approval_resolved")[0].body).toEqual({
      approvalId: ask.approvalId(),
      toolName: "bash",
      approved: false,
      reason: "superseded",
    });
  });

  it("clearSession teardown clears the column with reason timeout (never answered)", async () => {
    const opId = uid("op-teardown");
    writeOp(mkOp(opId));
    const sessionId = uid("sess-teardown");
    const ask = await askOpScoped(opId, sessionId);

    getApprovalManager().clearSession(sessionId);
    await expect(ask.outcome).resolves.toMatchObject({ approved: false, reason: "timeout" });

    expect(readOp(opId)?.canonical?.pendingApproval).toBeNull();
    expect(eventsOf(opId, "approval_resolved")[0].body).toMatchObject({
      approvalId: ask.approvalId(),
      approved: false,
      reason: "timeout",
    });
  });
});
