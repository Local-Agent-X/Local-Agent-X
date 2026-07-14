// Durable fallback for approval_response frames whose approvalId is not
// live in the in-process ApprovalManager (server restarted since the ask,
// or the client is answering a rediscovered card from
// GET /api/approvals/pending). Split out of message-router.ts for the
// 400-LOC gate — same sibling pattern as agent-controls.ts.
//
// The client MUST send the opId for durable resolution — rediscovered cards
// carry it (pending-route entries include opId), so it is always available.
// No directory scan happens here: requiring opId keeps this path O(1) on a
// hot WS handler. Without an opId the id is genuinely unknown → error reply.
//
// Expiry: a column older than APPROVAL_TIMEOUT_MS is a dead card — the
// user's decision must NOT be recorded on it. It is settled as a timeout
// (resolveExpiredPendingApproval, delivery "recorded") and the client gets
// the error reply.
//
// Live-window resolution routes through opResolveApproval (canonical-loop
// control-api-approvals.ts): the decision is stored on the column
// (record.resolution) for recovery's re-ask to apply, and the reply carries
// the existing `approval_resolved` ServerEvent shape plus delivery:
// "recorded" so durable cards render distinctly from a live settle.
//
// Canonical-loop is imported dynamically — chat-ws is loaded by the server
// front door before the canonical barrel; a static import here would mint
// the same cycle bridge-control.ts / agent-controls.ts avoid.

import type { WebSocket } from "ws";
import { createLogger } from "../logger.js";
import { APPROVAL_TIMEOUT_MS } from "../approval-manager.js";

const logger = createLogger("chat-ws");

interface CanonicalApprovalControls {
  readPendingApproval: (opId: string) => {
    approvalId: string;
    toolName: string;
    requestedAt: number;
  } | null;
  resolveExpiredPendingApproval: (opId: string) => boolean;
  opResolveApproval: (
    opId: string,
    approvalId: string,
    approved: boolean,
    rememberForSession?: boolean,
  ) =>
    | { ok: true; delivery: "delivered" | "recorded" }
    | { ok: false; code: string; message: string };
}

type CanonicalImport = () => Promise<CanonicalApprovalControls>;

const realCanonicalImport: CanonicalImport = () => import("../canonical-loop/index.js");
let importCanonical: CanonicalImport = realCanonicalImport;

/** Test-only: swap the canonical barrel import (null restores the real one). */
export function _setCanonicalImportForTest(fn: CanonicalImport | null): void {
  importCanonical = fn ?? realCanonicalImport;
}

/**
 * Resolve an approval that resolveApproval() did not know. Requires the
 * client-sent `opId` (durable cards rediscovered via /api/approvals/pending
 * carry it); frames without one get the existing unknown-approval error.
 */
export async function resolveDurableApproval(
  ws: WebSocket,
  approvalId: string,
  approved: boolean,
  rememberForSession: boolean,
  opIdFromClient: unknown,
): Promise<void> {
  const send = (payload: Record<string, unknown>) => {
    try { ws.send(JSON.stringify(payload)); } catch { /* socket gone */ }
  };
  const unknown = () => send({ type: "error", message: `Unknown or expired approval: ${approvalId}` });
  const opId = typeof opIdFromClient === "string" && opIdFromClient ? opIdFromClient : null;
  if (!opId) {
    unknown();
    return;
  }
  try {
    const { readPendingApproval, resolveExpiredPendingApproval, opResolveApproval } =
      await importCanonical();
    const pending = readPendingApproval(opId);
    if (!pending || pending.approvalId !== approvalId) {
      unknown();
      return;
    }
    if (Date.now() - pending.requestedAt >= APPROVAL_TIMEOUT_MS) {
      // Dead card: settle it as a timeout instead of recording the user's
      // decision on an ask window that already closed.
      resolveExpiredPendingApproval(opId);
      logger.info(`[ws-chat] durable approval ${approvalId} (op ${opId}) expired — resolved as timeout, decision dropped`);
      unknown();
      return;
    }
    const result = opResolveApproval(opId, approvalId, approved, rememberForSession);
    if (!result.ok) {
      unknown();
      return;
    }
    logger.info(`[ws-chat] durable approval resolve ${approvalId} op=${opId} approved=${approved} delivery=${result.delivery}`);
    send({ type: "approval_resolved", approvalId, toolName: pending.toolName, approved, delivery: result.delivery });
  } catch (e) {
    send({ type: "error", message: `Approval response failed: ${e}` });
  }
}
