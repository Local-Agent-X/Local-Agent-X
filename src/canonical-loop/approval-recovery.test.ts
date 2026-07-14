/**
 * A4 — recovery re-emit + dedupe semantics for durable pending approvals.
 *
 * Covers:
 *   - stale-record hygiene: recoverStaleOp (and the boot sweep, which routes
 *     through it) resolves an EXPIRED pendingApproval column as timeout with
 *     delivery: "recorded"; a still-live column is preserved untouched
 *   - re-ask continuity: a recovery re-ask for the SAME (toolName,
 *     argsPreview) inherits the original requestedAt (column + in-process
 *     timer honor the REMAINING window) and logs the continuity
 *   - honest windows: an already-expired survivor is resolved as timeout and
 *     the re-ask gets a fresh window; a DIFFERENT re-ask supersedes the
 *     survivor
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
const dataDir = mkdtempSync(join(tmpdir(), "lax-approval-recovery-"));
process.env.LAX_DATA_DIR = dataDir;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const {
  recoverStaleOp,
  sweepStaleCanonicalOps,
  resolveExpiredPendingApproval,
  readPendingApproval,
  opEventsSince,
  OP_EVENTS_FROM_BEGINNING,
} = await import("./index.js");
const { writeOp, readOp } = await import("../ops/op-store.js");
const { getApprovalManager, APPROVAL_TIMEOUT_MS } = await import("../approval-manager.js");

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

const survivorRecord = (over: Partial<{
  approvalId: string; toolName: string; argsPreview: string; requestedAt: number;
}> = {}) => ({
  approvalId: "apr-dead-1",
  toolName: "bash",
  toolCallId: "tc-crashed",
  argsPreview: `{"command":"rm -rf build"}`,
  context: "irreversible",
  requestedAt: Date.now(),
  ...over,
});

/** Op that crashed while cancelling (C3 orphan: no lease). Recovery closes it
 *  out as cancelled without requeueing — the quietest recoverable shape. */
function writeCrashedOp(opId: string, pendingApproval: ReturnType<typeof survivorRecord>): void {
  writeOp(mkOp(opId, {
    status: "running",
    canonical: { flagValue: true, state: "cancelling", pendingApproval },
  }));
}

function resolvedEvents(opId: string) {
  const res = opEventsSince(opId, OP_EVENTS_FROM_BEGINNING);
  if (!res.ok) throw new Error(`opEventsSince failed: ${res.code}`);
  return res.events.filter(e => e.type === "approval_resolved");
}

/** Ask through the REAL manager with an opId, waiting until the card exists. */
async function askOpScoped(opId: string, sessionId: string, args: Record<string, unknown>, toolName = "bash") {
  const events: ServerEvent[] = [];
  let approvalId = "";
  let sawCard: () => void = () => {};
  const cardSeen = new Promise<void>(res => { sawCard = res; });
  const outcome = getApprovalManager().requestApprovalDetailed({
    toolName,
    toolCallId: "tc-1",
    sessionId,
    context: "test ask",
    args,
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

describe("recovery stale-approval hygiene", () => {
  it("expired column at recovery → cleared + approval_resolved(timeout, recorded)", () => {
    const opId = uid("op-expired");
    const rec = survivorRecord({ requestedAt: Date.now() - APPROVAL_TIMEOUT_MS - 1_000 });
    writeCrashedOp(opId, rec);

    const outcome = recoverStaleOp(opId);
    expect(outcome).toEqual({ ok: true, kind: "cancelled", expiredWorkerId: undefined });

    expect(readOp(opId)?.canonical?.pendingApproval).toBeNull();
    const evs = resolvedEvents(opId);
    expect(evs).toHaveLength(1);
    expect(evs[0].body).toEqual({
      approvalId: rec.approvalId,
      toolName: rec.toolName,
      approved: false,
      reason: "timeout",
      delivery: "recorded",
    });
  });

  it("live (not expired) column at recovery → preserved untouched", () => {
    const opId = uid("op-live");
    const rec = survivorRecord({ requestedAt: Date.now() - 60_000 });
    writeCrashedOp(opId, rec);

    const outcome = recoverStaleOp(opId);
    expect(outcome.ok).toBe(true);

    expect(readOp(opId)?.canonical?.pendingApproval).toEqual(rec);
    expect(resolvedEvents(opId)).toHaveLength(0);
  });

  it("boot sweep routes expired columns through the same hygiene", () => {
    const opId = uid("op-sweep");
    const rec = survivorRecord({ requestedAt: Date.now() - APPROVAL_TIMEOUT_MS - 1_000 });
    writeCrashedOp(opId, rec);

    const outcomes = sweepStaleCanonicalOps();
    expect(outcomes.some(o => o.opId === opId && o.outcome.ok)).toBe(true);

    expect(readOp(opId)?.canonical?.pendingApproval).toBeNull();
    expect(resolvedEvents(opId)).toHaveLength(1);
  });

  it("resolveExpiredPendingApproval is a no-op for missing or live columns", () => {
    const opId = uid("op-noop");
    writeOp(mkOp(opId));
    expect(resolveExpiredPendingApproval(opId)).toBe(false);

    const rec = survivorRecord();
    writeCrashedOp(opId, rec);
    expect(resolveExpiredPendingApproval(opId)).toBe(false);
    expect(readPendingApproval(opId)).toEqual(rec);
  });
});

describe("re-ask continuity after recovery", () => {
  it("same fingerprint within the original window → requestedAt carried over + info log", async () => {
    const opId = uid("op-carry");
    const args = { command: `echo carry-${opId}` };
    const originalRequestedAt = Date.now() - 2 * 60_000;
    const rec = survivorRecord({ argsPreview: JSON.stringify(args), requestedAt: originalRequestedAt });
    writeCrashedOp(opId, rec);

    const logSpy = vi.spyOn(console, "log");
    try {
      const ask = await askOpScoped(opId, uid("sess"), args);
      const newId = ask.approvalId();
      expect(newId).not.toBe(rec.approvalId);

      const column = readPendingApproval(opId);
      expect(column?.approvalId).toBe(newId);
      expect(column?.requestedAt).toBe(originalRequestedAt);

      // The survivor is NOT resolved — it continues as the new card.
      expect(resolvedEvents(opId)).toHaveLength(0);
      expect(logSpy.mock.calls.some(c => String(c[0]).includes("approval re-asked after recovery"))).toBe(true);

      getApprovalManager().resolveApproval(newId, true);
      await expect(ask.outcome).resolves.toMatchObject({ approved: true });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("in-process timer honors the REMAINING window, not a fresh 5 minutes", async () => {
    const opId = uid("op-remaining");
    const args = { command: `echo remaining-${opId}` };
    const rec = survivorRecord({
      argsPreview: JSON.stringify(args),
      requestedAt: Date.now() - (APPROVAL_TIMEOUT_MS - 150),
    });
    writeCrashedOp(opId, rec);

    const ask = await askOpScoped(opId, uid("sess"), args);
    // Times out ~150ms after the re-ask — nowhere near APPROVAL_TIMEOUT_MS.
    await expect(ask.outcome).resolves.toEqual({ approved: false, reason: "timeout" });

    expect(readPendingApproval(opId)).toBeNull();
    const evs = resolvedEvents(opId);
    expect(evs).toHaveLength(1);
    expect(evs[0].body).toMatchObject({ approvalId: ask.approvalId(), approved: false, reason: "timeout" });
  }, 10_000);

  it("re-ask after the original window expired → old record timeout, fresh window", async () => {
    const opId = uid("op-fresh");
    const args = { command: `echo fresh-${opId}` };
    const rec = survivorRecord({
      argsPreview: JSON.stringify(args),
      requestedAt: Date.now() - APPROVAL_TIMEOUT_MS - 1_000,
    });
    writeCrashedOp(opId, rec);

    const before = Date.now();
    const ask = await askOpScoped(opId, uid("sess"), args);
    const newId = ask.approvalId();

    const evs = resolvedEvents(opId);
    expect(evs).toHaveLength(1);
    expect(evs[0].body).toEqual({
      approvalId: rec.approvalId,
      toolName: rec.toolName,
      approved: false,
      reason: "timeout",
      delivery: "recorded",
    });

    const column = readPendingApproval(opId);
    expect(column?.approvalId).toBe(newId);
    expect(column?.requestedAt).toBeGreaterThanOrEqual(before);

    getApprovalManager().resolveApproval(newId, true);
    await expect(ask.outcome).resolves.toMatchObject({ approved: true });
  });

  it("re-ask for a DIFFERENT tool → old record superseded + new column", async () => {
    const opId = uid("op-different");
    const args = { command: `echo different-${opId}` };
    const rec = survivorRecord({ toolName: "delete_file", argsPreview: `{"path":"/tmp/x"}`, requestedAt: Date.now() - 60_000 });
    writeCrashedOp(opId, rec);

    const before = Date.now();
    const ask = await askOpScoped(opId, uid("sess"), args, "bash");
    const newId = ask.approvalId();

    const evs = resolvedEvents(opId);
    expect(evs).toHaveLength(1);
    expect(evs[0].body).toEqual({
      approvalId: rec.approvalId,
      toolName: "delete_file",
      approved: false,
      reason: "superseded",
      delivery: "recorded",
    });

    const column = readPendingApproval(opId);
    expect(column?.approvalId).toBe(newId);
    expect(column?.toolName).toBe("bash");
    expect(column?.requestedAt).toBeGreaterThanOrEqual(before);

    getApprovalManager().resolveApproval(newId, true);
    await expect(ask.outcome).resolves.toMatchObject({ approved: true });
  });
});
