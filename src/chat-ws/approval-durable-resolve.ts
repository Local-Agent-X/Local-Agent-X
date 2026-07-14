// Durable fallback for approval_response frames whose approvalId is not
// live in the in-process ApprovalManager (server restarted since the ask,
// or the client is answering a rediscovered card from
// GET /api/approvals/pending). Split out of message-router.ts for the
// 400-LOC gate — same sibling pattern as agent-controls.ts.
//
// Resolution routes through opResolveApproval (canonical-loop
// control-api-approvals.ts): live card → delivered; column-only card →
// durable clear + approval_resolved event, delivery "recorded". On success
// this replies to the asking socket with the existing `approval_resolved`
// ServerEvent shape plus a `delivery` field so durable cards can render
// "recorded, applies on recovery" distinctly from a live settle.
//
// Canonical-loop is imported dynamically — chat-ws is loaded by the server
// front door before the canonical barrel; a static import here would mint
// the same cycle bridge-control.ts / agent-controls.ts avoid.

import type { WebSocket } from "ws";
import { createLogger } from "../logger.js";

const logger = createLogger("chat-ws");

interface CanonicalApprovalControls {
  listActiveCanonicalOps: () => Array<{
    opId: string;
    pendingApproval: { approvalId: string; toolName: string } | null;
  }>;
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
 * Resolve an approval that resolveApproval() did not know. `opId` comes from
 * the client when it answers a durable card (rediscovered via
 * /api/approvals/pending — entries carry opId); without one, the active-op
 * columns are scanned for a matching approvalId.
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
  try {
    const { listActiveCanonicalOps, opResolveApproval } = await importCanonical();
    let opId = typeof opIdFromClient === "string" && opIdFromClient ? opIdFromClient : null;
    const ops = listActiveCanonicalOps();
    const row = opId
      ? ops.find((o) => o.opId === opId)
      : ops.find((o) => o.pendingApproval?.approvalId === approvalId);
    if (!opId) opId = row?.opId ?? null;
    if (!opId) {
      send({ type: "error", message: `Unknown or expired approval: ${approvalId}` });
      return;
    }
    // Capture toolName BEFORE resolving — the durable write clears the column.
    const toolName = row?.pendingApproval?.approvalId === approvalId
      ? row.pendingApproval.toolName
      : "";

    const result = opResolveApproval(opId, approvalId, approved, rememberForSession);
    if (!result.ok) {
      send({ type: "error", message: `Unknown or expired approval: ${approvalId}` });
      return;
    }
    logger.info(`[ws-chat] durable approval resolve ${approvalId} op=${opId} approved=${approved} delivery=${result.delivery}`);
    send({ type: "approval_resolved", approvalId, toolName, approved, delivery: result.delivery });
  } catch (e) {
    send({ type: "error", message: `Approval response failed: ${e}` });
  }
}
