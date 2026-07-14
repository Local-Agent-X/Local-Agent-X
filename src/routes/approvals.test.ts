/**
 * Pending-approval rediscovery route (GET /api/approvals/pending).
 *
 * Covers:
 *   - projection: only ops with a non-null pendingApproval column appear
 *   - expiry filtering: cards past requestedAt + 5 min are dropped
 *   - entry shape: opId/sessionId/approvalId/toolName/argsPreview/context/
 *     requestedAt/expiresAt, with context defaulting to null
 *   - handler: 200 + JSON array on the exact method+path, false otherwise
 */
import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../server-context.js";
import type { Role } from "../rbac.js";
import type { ActiveCanonicalOp } from "../canonical-loop/index.js";
import { APPROVAL_TIMEOUT_MS } from "../approval-manager.js";
import { buildPendingApprovals, handleApprovalRoutes } from "./approvals.js";

const NOW = 1_750_000_000_000;

function mkOp(over: Partial<ActiveCanonicalOp> = {}): ActiveCanonicalOp {
  return {
    path: "canonical",
    opId: "op_1",
    lane: "interactive",
    state: "running",
    adapter: null,
    adapterVersion: null,
    startedAt: new Date(NOW - 60_000).toISOString(),
    leaseExpiresAt: null,
    workerId: null,
    sessionId: "sess-1",
    pendingApproval: null,
    ...over,
  };
}

const pending = (over: Partial<NonNullable<ActiveCanonicalOp["pendingApproval"]>> = {}) => ({
  approvalId: "apr-1",
  toolName: "bash",
  argsPreview: `{"command":"rm -rf build"}`,
  context: "irreversible",
  requestedAt: NOW - 1_000,
  ...over,
});

describe("buildPendingApprovals", () => {
  it("returns [] for no ops and for ops without a pendingApproval column", () => {
    expect(buildPendingApprovals([], NOW)).toEqual([]);
    expect(buildPendingApprovals([mkOp(), mkOp({ opId: "op_2" })], NOW)).toEqual([]);
  });

  it("projects a pending op into the full entry shape", () => {
    const ops = [mkOp({ pendingApproval: pending() })];
    expect(buildPendingApprovals(ops, NOW)).toEqual([{
      opId: "op_1",
      sessionId: "sess-1",
      approvalId: "apr-1",
      toolName: "bash",
      argsPreview: `{"command":"rm -rf build"}`,
      context: "irreversible",
      requestedAt: NOW - 1_000,
      expiresAt: NOW - 1_000 + APPROVAL_TIMEOUT_MS,
    }]);
  });

  it("filters cards at or past the 5-minute expiry, keeps ones just inside it", () => {
    const ops = [
      mkOp({ opId: "op_expired", pendingApproval: pending({ approvalId: "apr-old", requestedAt: NOW - APPROVAL_TIMEOUT_MS }) }),
      mkOp({ opId: "op_fresh", pendingApproval: pending({ approvalId: "apr-new", requestedAt: NOW - APPROVAL_TIMEOUT_MS + 1 }) }),
    ];
    const out = buildPendingApprovals(ops, NOW);
    expect(out.map(e => e.approvalId)).toEqual(["apr-new"]);
  });

  it("filters cards carrying a recorded decision (already answered, awaiting recovery)", () => {
    const ops = [
      mkOp({
        opId: "op_answered",
        pendingApproval: pending({ approvalId: "apr-done", resolution: { approved: true, resolvedAt: NOW - 500 } }),
      }),
      mkOp({ opId: "op_open", pendingApproval: pending({ approvalId: "apr-open" }) }),
    ];
    expect(buildPendingApprovals(ops, NOW).map(e => e.approvalId)).toEqual(["apr-open"]);
  });

  it("defaults a missing context to null and skips a malformed requestedAt", () => {
    const ops = [
      mkOp({ pendingApproval: pending({ context: undefined }) }),
      mkOp({
        opId: "op_bad",
        pendingApproval: pending({ approvalId: "apr-bad", requestedAt: undefined as unknown as number }),
      }),
    ];
    const out = buildPendingApprovals(ops, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].context).toBeNull();
  });
});

// ── handler ────────────────────────────────────────────────────────────────

// The handler filters against the REAL clock, so the mocked card's
// requestedAt must be near Date.now(), not the fixed NOW above.
vi.mock("../canonical-loop/index.js", () => ({
  listActiveCanonicalOps: () => [
    mkOp({ pendingApproval: pending({ requestedAt: Date.now() - 1_000 }) }),
    mkOp({ opId: "op_idle", pendingApproval: null }),
  ],
}));

function mkRes() {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => { status = s; },
    end: (b: string) => { body = b; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => JSON.parse(body) as unknown };
}

const req = { headers: {} } as IncomingMessage;
const ctx = {} as ServerContext;
const role = "owner" as Role;

describe("handleApprovalRoutes", () => {
  it("GET /api/approvals/pending → 200 with only pending-carrying ops", async () => {
    const { res, status, body } = mkRes();
    const handled = await handleApprovalRoutes(
      "GET", new URL("http://localhost/api/approvals/pending"), req, res, ctx, role,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    const entries = body() as Array<{ opId: string; approvalId: string; expiresAt: number }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].opId).toBe("op_1");
    expect(entries[0].approvalId).toBe("apr-1");
    expect(entries[0].expiresAt).toBeGreaterThan(Date.now());
  });

  it("does not claim other paths or methods", async () => {
    const { res } = mkRes();
    expect(await handleApprovalRoutes("POST", new URL("http://localhost/api/approvals/pending"), req, res, ctx, role)).toBe(false);
    expect(await handleApprovalRoutes("GET", new URL("http://localhost/api/approvals"), req, res, ctx, role)).toBe(false);
  });
});
