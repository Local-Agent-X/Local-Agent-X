/**
 * WS durable-resolve fallback for approval_response frames the in-process
 * ApprovalManager doesn't know (server restart / rediscovered durable card).
 *
 * Covers:
 *   - unknown in-process id + client-sent opId with a matching, in-window
 *     column → opResolveApproval called, approval_resolved reply with
 *     delivery:"recorded"
 *   - no opId on the frame → error reply, canonical layer never touched
 *     (durable resolution REQUIRES the client-sent opId; no directory scan)
 *   - expired column → resolved as timeout via resolveExpiredPendingApproval,
 *     the user's decision is NOT recorded, error reply
 *   - column mismatch / opResolveApproval failure → the existing error shape
 *   - router wiring: an approval_response frame whose id the manager rejects
 *     falls through to the durable path (happy path untouched)
 */
import { describe, it, expect, beforeEach, afterAll, vi, type Mock } from "vitest";
import type { WebSocket } from "ws";
import { APPROVAL_TIMEOUT_MS } from "../approval-manager.js";
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

interface Fakes {
  resolve: Mock<OpResolveFn>;
  expire: Mock<(opId: string) => boolean>;
}

function fakeCanonical(over: {
  pending?: Record<string, { approvalId: string; toolName: string; requestedAt: number }>;
  resolve?: Mock<OpResolveFn>;
} = {}): Fakes {
  const resolve: Mock<OpResolveFn> =
    over.resolve ?? vi.fn<OpResolveFn>(() => ({ ok: true, delivery: "recorded" }));
  const expire = vi.fn((_opId: string) => true);
  _setCanonicalImportForTest(async () => ({
    readPendingApproval: (opId: string) => over.pending?.[opId] ?? null,
    resolveExpiredPendingApproval: expire,
    opResolveApproval: resolve,
  }));
  return { resolve, expire };
}

const inWindow = (approvalId: string) => ({ approvalId, toolName: "bash", requestedAt: Date.now() - 1_000 });

beforeEach(() => _setCanonicalImportForTest(null));

describe("resolveDurableApproval", () => {
  it("client-sent opId with a matching in-window column → recorded + approval_resolved reply", async () => {
    const { resolve } = fakeCanonical({ pending: { op_a: inWindow("apr-1") } });
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

  it("no opId on the frame → error reply, no resolve attempt", async () => {
    const { resolve } = fakeCanonical({ pending: { op_b: inWindow("apr-2") } });
    const { ws, frames } = mkWs();
    await resolveDurableApproval(ws, "apr-2", true, false, undefined);

    expect(resolve).not.toHaveBeenCalled();
    expect(frames()).toEqual([{ type: "error", message: "Unknown or expired approval: apr-2" }]);
  });

  it("expired column → timeout via resolveExpiredPendingApproval, decision dropped, error reply", async () => {
    const { resolve, expire } = fakeCanonical({
      pending: {
        op_c: { approvalId: "apr-3", toolName: "bash", requestedAt: Date.now() - APPROVAL_TIMEOUT_MS },
      },
    });
    const { ws, frames } = mkWs();
    await resolveDurableApproval(ws, "apr-3", true, false, "op_c");

    expect(expire).toHaveBeenCalledWith("op_c");
    expect(resolve).not.toHaveBeenCalled();
    expect(frames()).toEqual([{ type: "error", message: "Unknown or expired approval: apr-3" }]);
  });

  it("column belongs to a different approvalId → error reply, no resolve attempt", async () => {
    const { resolve } = fakeCanonical({ pending: { op_d: inWindow("apr-other") } });
    const { ws, frames } = mkWs();
    await resolveDurableApproval(ws, "apr-ghost", true, false, "op_d");

    expect(resolve).not.toHaveBeenCalled();
    expect(frames()).toEqual([{ type: "error", message: "Unknown or expired approval: apr-ghost" }]);
  });

  it("opResolveApproval failure → error reply", async () => {
    fakeCanonical({
      pending: { op_e: inWindow("apr-5") },
      resolve: vi.fn<OpResolveFn>(() => ({ ok: false, code: "unknown_op", message: "gone" })),
    });
    const { ws, frames } = mkWs();
    await resolveDurableApproval(ws, "apr-5", false, false, "op_e");

    expect(frames()).toEqual([{ type: "error", message: "Unknown or expired approval: apr-5" }]);
  });
});

describe("message-router approval_response wiring", () => {
  it("an id the manager rejects falls through to the durable path", async () => {
    const { resolve } = fakeCanonical({ pending: { op_ws: inWindow("apr-ws") } });
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
