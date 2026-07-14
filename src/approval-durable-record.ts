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
  /** Decision recorded post-restart while no card was live (see
   *  canonical-loop/types.ts PendingApprovalRecord.resolution). Never set on
   *  ask-side writes; read-side only, for reconcileRecoveredAsk. */
  resolution?: { approved: boolean; resolvedAt: number };
}

interface CanonicalApprovalBridge {
  recordApprovalRequested: (opId: string, record: DurableApprovalRequest) => void;
  recordApprovalResolved: (
    opId: string,
    res: {
      approvalId: string;
      toolName: string;
      approved: boolean;
      reason?: ApprovalDenyReason;
      delivery?: "delivered" | "recorded";
    },
  ) => void;
  readPendingApproval: (opId: string) => DurableApprovalRequest | null;
  consumePendingApproval: (opId: string, approvalId: string) => void;
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
          readPendingApproval: mod.readPendingApproval,
          consumePendingApproval: mod.consumePendingApproval,
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
  delivery?: "delivered" | "recorded",
): void {
  if (!canonicalBridge) {
    logger.warn(`no canonical bridge at resolve — approval ${approvalId} (op ${opId}) settled without a durable approval_resolved record`);
    return;
  }
  try {
    canonicalBridge.recordApprovalResolved(opId, { approvalId, toolName, approved, reason, delivery });
  } catch (e) {
    logger.warn(`failed durable approval_resolved for ${approvalId} (op ${opId}, tool ${toolName}) — pendingApproval column may be stale: ${(e as Error)?.message ?? String(e)}`);
  }
}

/** Read the op's crash-surviving pendingApproval column (re-ask continuity —
 *  see reconcileRecoveredAsk below). Sync; requires a prior
 *  ensureDurableBridge() await. Best-effort: null when the bridge is absent
 *  or the read throws — the ask then proceeds as a fresh window. */
export function readDurableRequest(opId: string): DurableApprovalRequest | null {
  if (!canonicalBridge) return null; // import failed — already warned at load
  try {
    return canonicalBridge.readPendingApproval(opId);
  } catch (e) {
    logger.warn(`failed reading pendingApproval column for op ${opId} — re-ask continues with a fresh window: ${(e as Error)?.message ?? String(e)}`);
    return null;
  }
}

export interface RecoveredAskReconciliation {
  /** Original requestedAt to inherit (remaining window), or null for fresh. */
  carriedRequestedAt: number | null;
  /** A decision the user recorded post-restart (opResolveApproval, delivery
   *  "recorded") for THIS exact ask — apply it as the outcome without
   *  registering a card. Null when there is nothing to apply. */
  recordedDecision: { approved: boolean } | null;
}

const NO_RECONCILIATION: RecoveredAskReconciliation = { carriedRequestedAt: null, recordedDecision: null };

/**
 * Re-ask continuity after crash recovery. A pendingApproval column whose
 * approvalId no live card owns is a crash survivor: the op died blocked on
 * that card and recovery re-drove the turn, producing THIS re-ask.
 *
 *   - Survivor carries a recorded decision (resolution) for the SAME
 *     (toolName, argsPreview) within the original 5-min window → APPLY it:
 *     consume the column (no new event — approval_resolved was appended when
 *     the decision was recorded) and return the decision as the outcome.
 *   - Same ask, window still open, no decision → return the original
 *     requestedAt so the new card inherits the REMAINING budget instead of
 *     restarting from zero across restarts.
 *   - Original window already expired → resolve the old record as timeout
 *     (delivery: "recorded") — including a never-consumed recorded decision,
 *     whose window is equally over — and give this ask a fresh, honest window.
 *   - Different ask → resolve the old record as superseded; the re-driven
 *     turn went another way.
 */
export function reconcileRecoveredAsk(
  opId: string,
  toolName: string,
  argsPreview: string,
  isLiveCard: (approvalId: string) => boolean,
  timeoutMs: number,
): RecoveredAskReconciliation {
  const survivor = readDurableRequest(opId);
  if (!survivor) return NO_RECONCILIATION;
  // A column owned by a live card is not a survivor — its own settle path
  // clears it. (Op tool dispatch is sequential, so this is belt-and-braces.)
  if (isLiveCard(survivor.approvalId)) return NO_RECONCILIATION;
  const expired = Date.now() - survivor.requestedAt >= timeoutMs;
  if (!expired && survivor.toolName === toolName && survivor.argsPreview === argsPreview) {
    if (survivor.resolution) {
      consumeDurablePending(opId, survivor.approvalId);
      logger.info(`applying recorded approval from restart: ${survivor.approvalId} (op ${opId}, tool ${toolName}) approved=${survivor.resolution.approved}`);
      return { carriedRequestedAt: null, recordedDecision: { approved: survivor.resolution.approved } };
    }
    logger.info(`approval re-asked after recovery, original requestedAt=${new Date(survivor.requestedAt).toISOString()} carried over (op ${opId}, tool ${toolName}, prior approval ${survivor.approvalId})`);
    return { carriedRequestedAt: survivor.requestedAt, recordedDecision: null };
  }
  recordDurableResolve(opId, survivor.approvalId, survivor.toolName, false, expired ? "timeout" : "superseded", "recorded");
  return NO_RECONCILIATION;
}

/** Clear the column after its recorded decision is consumed — NO event
 *  append (see consumePendingApproval). Best-effort, warns on failure. */
function consumeDurablePending(opId: string, approvalId: string): void {
  if (!canonicalBridge) return; // import failed — already warned at load
  try {
    canonicalBridge.consumePendingApproval(opId, approvalId);
  } catch (e) {
    logger.warn(`failed consuming recorded approval ${approvalId} (op ${opId}) — column may be stale: ${(e as Error)?.message ?? String(e)}`);
  }
}
