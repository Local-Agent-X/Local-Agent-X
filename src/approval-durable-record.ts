/**
 * Durable-record bridge for op-scoped approvals (split out of
 * approval-manager.ts for the 400-LOC gate).
 *
 * Op-scoped asks get a durable shadow: a pendingApproval signal column on
 * the op plus approval_requested / approval_resolved canonical events,
 * written by canonical-loop/control-api-approvals.ts. Loaded lazily through
 * the front door (canonical-loop imports tool-execution which imports
 * approval-manager, so a static import of the barrel would mint a cycle —
 * same dynamic-import pattern as bridge-control.ts /
 * chat-ws/agent-controls.ts).
 *
 * Everything here is BEST-EFFORT: a failed import or a failed durable write
 * warns and returns — it never throws into the live approval card's path.
 */
import { createLogger } from "./logger.js";
import type { ApprovalDenyReason } from "./approval-manager.js";

const logger = createLogger("approval-manager");

export interface DurableApprovalRequest {
  approvalId: string;
  toolName: string;
  toolCallId?: string;
  argsPreview: string;
  context?: string;
  requestedAt: number;
}

interface CanonicalApprovalBridge {
  recordApprovalRequested: (opId: string, record: DurableApprovalRequest) => void;
  recordApprovalResolved: (
    opId: string,
    res: { approvalId: string; toolName: string; approved: boolean; reason?: ApprovalDenyReason },
  ) => void;
}

type CanonicalBarrelImport = () => Promise<CanonicalApprovalBridge>;

const realCanonicalBarrelImport: CanonicalBarrelImport = () => import("./canonical-loop/index.js");
let importCanonicalBarrel: CanonicalBarrelImport = realCanonicalBarrelImport;
let canonicalBridge: CanonicalApprovalBridge | null = null;
let canonicalBridgeLoading: Promise<CanonicalApprovalBridge | null> | null = null;

/** Test-only: swap the barrel import (null restores the real one) and reset
 *  the cached bridge so load failure / retry paths are exercisable. */
export function _setCanonicalBarrelImportForTest(fn: CanonicalBarrelImport | null): void {
  importCanonicalBarrel = fn ?? realCanonicalBarrelImport;
  canonicalBridge = null;
  canonicalBridgeLoading = null;
}

/**
 * Best-effort loader: resolves null (never rejects) when the barrel import
 * fails, so an op-scoped ask still puts up its live card — it just loses the
 * durable shadow. A failed load is NOT cached: `canonicalBridgeLoading` is
 * reset on rejection so the next ask retries the import instead of every
 * subsequent op-scoped approval being permanently bricked.
 *
 * The approval manager awaits this BEFORE registering an op-scoped card, so
 * the synchronous record functions below can rely on the cached reference.
 */
export async function ensureDurableBridge(): Promise<void> {
  if (canonicalBridge) return;
  if (!canonicalBridgeLoading) {
    canonicalBridgeLoading = importCanonicalBarrel().then(
      (mod) => {
        canonicalBridge = {
          recordApprovalRequested: mod.recordApprovalRequested,
          recordApprovalResolved: mod.recordApprovalResolved,
        };
        return canonicalBridge;
      },
      (e: unknown) => {
        canonicalBridgeLoading = null;
        logger.warn(`canonical bridge import failed — approval will have no durable record this ask: ${(e as Error)?.message ?? String(e)}`);
        return null;
      },
    );
  }
  await canonicalBridgeLoading;
}

/** Write the pendingApproval column + approval_requested event. Sync;
 *  requires a prior ensureDurableBridge() await. Warns instead of throwing —
 *  the live card must still work without the durable record. */
export function recordDurableRequest(opId: string, record: DurableApprovalRequest): void {
  if (!canonicalBridge) return; // import failed — already warned at load
  try {
    canonicalBridge.recordApprovalRequested(opId, record);
  } catch (e) {
    logger.warn(`failed durable approval_requested for ${record.approvalId} (op ${opId}, tool ${record.toolName}): ${(e as Error)?.message ?? String(e)}`);
  }
}

/** Clear the pendingApproval column + append approval_resolved. Sync; warns
 *  instead of throwing — durable bookkeeping must never block settling the
 *  card. A failure here leaves a stale pendingApproval column on the op, so
 *  the warn carries the ids a stale-column report needs. */
export function recordDurableResolve(
  opId: string,
  approvalId: string,
  toolName: string,
  approved: boolean,
  reason?: ApprovalDenyReason,
): void {
  if (!canonicalBridge) {
    logger.warn(`no canonical bridge at resolve — approval ${approvalId} (op ${opId}) settled without a durable approval_resolved record`);
    return;
  }
  try {
    canonicalBridge.recordApprovalResolved(opId, { approvalId, toolName, approved, reason });
  } catch (e) {
    logger.warn(`failed durable approval_resolved for ${approvalId} (op ${opId}, tool ${toolName}) — pendingApproval column may be stale: ${(e as Error)?.message ?? String(e)}`);
  }
}
