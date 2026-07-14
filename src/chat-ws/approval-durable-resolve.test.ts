/**
 * WS durable-resolve fallback for approval_response frames the in-process
 * ApprovalManager doesn't know (server restart / rediscovered durable card).
 *
 * Covers:
 *   - unknown in-process id + client-supplied opId with a matching column →
 *     opResolveApproval called, approval_resolved reply with delivery:"recorded"
 *   - no opId on the frame → active-op columns scanned by approvalId
 *   - genuinely unknown approval (no opId, no matching column) → error reply,
 *     opResolveApproval never called
 *   - opResolveApproval unknown_approval → the existing error reply shape
 *   - router wiring: an approval_response frame whose id the manager rejects
 *     falls through to the durable path (happy path untouched)
 */
import { describe, it, expect, beforeEach, afterAll, vi, type Mock } from "vitest";
import type { WebSocket } from "ws";
import {
  resolveDurableApproval,
  _setCanonicalImportForTest,
} from "./approval-durable-resolve.js";
import { attachMessageRouter } from "./message-router.js";

afterAll(() => _setCanonicalImportForTest(null));

function mkWs() {
  const sent: string[] = [];
  const ws = { send: (p: string) => { sent.push(p); } } as unknown as WebSocket;
  return { ws, frames: () => sent.map(p => JSON.parse(p) as Record<string, unknown>) };
}

type OpResolveFn = (
  opId: string,
  approvalId: string,
  approved: boolean,
  rememberForSession?: boolean,
) =>
  | { ok: true; delivery: "delivered" | "recorded" }
  | { ok: false; code: string; message: string };

const activeOp = (opId: string, approvalId: string | null) => ({
  opId,
  pendingApproval: approvalId ? { approvalId, toolName: "bash" } : null,
});

function fakeCanonical(over: {
  ops?: Array<{ opId: string; pendingApproval: { approvalId: string; toolName: string } | null }>;
  resolve?: Mock<OpResolveFn>;
} = {}) {
  const opResolveApproval: Mock<OpResolveFn> =
    over.resolve ?? vi.fn<OpResolveFn>(() => ({ ok: true, delivery: "recorded" }));
  _setCanonicalImportForTest(async () => ({
    listActiveCanonicalOps: () => over.ops ?? [],
    opResolveApproval,
  }));
  return opResolveApproval;
}

beforeEach(() => _setCanonicalImportForTest(null));

describe("resolveDurableApproval", () => {
  it("client-supplied opId with matching column → recorded + approval_resolved reply", async () => {
    const resolve = fakeCanonical({ ops: [activeOp("op_a", "apr-1")] });
    const { ws, frames } = mkWs();
    await resolveDurableApproval(ws, "apr-1", true, false, "op_a");

    expect(resolve).toHaveBeenCalledWith("op_a", "apr-1", true, false);
    expect(frames()).toEqual([{
      type: "approval_resolved",
      approvalId: "apr-1",
      toolName: "bash",
      approved: true,
      delivery: "recorded",
    }]);
  });

  it("no opId on the frame → scans active-op columns by approvalId", async () => {
    const resolve = fakeCanonical({
      ops: [activeOp("op_other", "apr-x"), activeOp("op_b", "apr-2")],
    });
    const { ws, frames } = mkWs();
    await resolveDurableApproval(ws, "apr-2", false, true, undefined);

    expect(resolve).toHaveBeenCalledWith("op_b", "apr-2", false, true);
    expect(frames()[0]).toMatchObject({ type: "approval_resolved", approvalId: "apr-2", approved: false });
  });

  it("genuinely unknown approval → error reply, no resolve attempt", async () => {
    const resolve = fakeCanonical({ ops: [activeOp("op_c", null)] });
    const { ws, frames } = mkWs();
    await resolveDurableApproval(ws, "apr-ghost", true, false, undefined);

    expect(resolve).not.toHaveBeenCalled();
    expect(frames()).toEqual([{ type: "error", message: "Unknown or expired approval: apr-ghost" }]);
  });

  it("opResolveApproval unknown_approval → error reply", async () => {
    fakeCanonical({
      ops: [activeOp("op_d", "apr-stale")],
      resolve: vi.fn<OpResolveFn>(() => ({ ok: false, code: "unknown_approval", message: "gone" })),
    });
    const { ws, frames } = mkWs();
    await resolveDurableApproval(ws, "apr-other", true, false, "op_d");

    expect(frames()).toEqual([{ type: "error", message: "Unknown or expired approval: apr-other" }]);
  });
});

describe("message-router approval_response wiring", () => {
  it("an id the manager rejects falls through to the durable path", async () => {
    const resolve = fakeCanonical({ ops: [activeOp("op_ws", "apr-ws")] });
    const sent: string[] = [];
    let onMessage: ((data: Buffer) => unknown) | null = null;
    const ws = {
      readyState: 1,
      send: (p: string) => { sent.push(p); },
      on: (evt: string, cb: (data: Buffer) => unknown) => { if (evt === "message") onMessage = cb; },
    } as unknown as WebSocket;
    attachMessageRouter({ ws, subscriptions: new Set() });

    // No card with this id was ever registered in-process, so
    // ApprovalManager.resolveApproval returns false and the durable
    // fallback must take over.
    await onMessage!(Buffer.from(JSON.stringify({
      type: "approval_response", approvalId: "apr-ws", approved: true, opId: "op_ws",
    })));

    expect(resolve).toHaveBeenCalledWith("op_ws", "apr-ws", true, false);
    const frames = sent.map(p => JSON.parse(p) as Record<string, unknown>);
    expect(frames).toEqual([{
      type: "approval_resolved",
      approvalId: "apr-ws",
      toolName: "bash",
      approved: true,
      delivery: "recorded",
    }]);
  });
});
