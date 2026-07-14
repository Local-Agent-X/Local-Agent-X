// Pending-approval rediscovery.
//
// GET /api/approvals/pending — every active canonical op currently blocked on
// a durable approval card (canonical.pendingApproval signal column, written
// by canonical-loop/control-api-approvals.ts). Lets a client that missed the
// live `approval_requested` WS event (page reload, second device, server
// restart) rediscover the card and answer it via the durable-resolve path.
//
// Expiry shares the in-process card budget (approval-manager.ts
// APPROVAL_TIMEOUT_MS): a column older than that is either already timed
// out in-process or a stale crash leftover the recovery hygiene sweep will
// settle — neither is answerable, so it is filtered here rather than
// surfaced. Columns carrying a recorded decision (record.resolution) are
// likewise filtered: they are answered, awaiting consumption by recovery.
//
// Reuses listActiveCanonicalOps() (the one active-op listing seam) — no
// parallel ops walk. Canonical-loop is imported at request time, same lazy
// pattern as routes/health.ts.

import type { RouteHandler } from "../server-context.js";
import { jsonResponse } from "../server-utils.js";
import { APPROVAL_TIMEOUT_MS } from "../approval-manager.js";
import type { ActiveCanonicalOp } from "../canonical-loop/active-ops.js";

export interface PendingApprovalEntry {
  opId: string;
  sessionId: string | null;
  approvalId: string;
  toolName: string;
  argsPreview: string;
  context: string | null;
  /** Epoch ms the ask went out (PendingApprovalRecord.requestedAt). */
  requestedAt: number;
  /** requestedAt + APPROVAL_TIMEOUT_MS — past this the card is unanswerable. */
  expiresAt: number;
}

/** Pure projection: active ops → answerable pending-approval entries. */
export function buildPendingApprovals(
  ops: ActiveCanonicalOp[],
  now: number = Date.now(),
): PendingApprovalEntry[] {
  const out: PendingApprovalEntry[] = [];
  for (const op of ops) {
    const p = op.pendingApproval;
    if (!p || typeof p.requestedAt !== "number") continue;
    // Already answered (recorded decision awaiting recovery's re-ask) —
    // surfacing it again would invite a double answer.
    if (p.resolution) continue;
    const expiresAt = p.requestedAt + APPROVAL_TIMEOUT_MS;
    if (expiresAt <= now) continue;
    out.push({
      opId: op.opId,
      sessionId: op.sessionId,
      approvalId: p.approvalId,
      toolName: p.toolName,
      argsPreview: p.argsPreview,
      context: p.context ?? null,
      requestedAt: p.requestedAt,
      expiresAt,
    });
  }
  return out;
}

export const handleApprovalRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  if (method === "GET" && url.pathname === "/api/approvals/pending") {
    try {
      const { listActiveCanonicalOps } = await import("../canonical-loop/index.js");
      jsonResponse(res, 200, buildPendingApprovals(listActiveCanonicalOps()), req);
    } catch (e) {
      jsonResponse(res, 500, { error: (e as Error).message }, req);
    }
    return true;
  }
  return false;
};
