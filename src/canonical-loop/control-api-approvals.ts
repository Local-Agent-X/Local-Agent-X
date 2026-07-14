/**
 * Durable pending-approval control surface — sibling of control-api.ts,
 * split into its own file so both stay under the 400-LOC gate.
 *
 * Column semantics (`op.canonical.pendingApproval` — types.ts
 * PendingApprovalRecord):
 *
 *   SET      when an op-scoped approval "ask" goes out
 *            (approval-manager.ts → recordApprovalRequested). One column,
 *            latest-wins: an op blocks on at most one card at a time on the
 *            canonical path (tool dispatch is sequential per op).
 *   CLEARED  when the card settles — approve / deny / timeout / superseded /
 *            session teardown (approval-manager settle sites →
 *            recordApprovalResolved), or when opResolveApproval records a
 *            decision for a card that is no longer live in-process.
 *
 * Crash + recovery: the ApprovalManager's pending map and its resolve
 *   closures die with the process — the durable column and the
 *   approval_requested / approval_resolved events are the ONLY survivors.
 *   Recovery re-drives the uncommitted turn and the tool re-asks with a
 *   FRESH approval id (recovery.ts) — that re-ask overwrites the column via
 *   recordApprovalRequested. A stale column (record whose approvalId no
 *   process knows) therefore means "the op died blocked on this card";
 *   consumption of that state on re-drive (re-emit / dedupe against the
 *   fresh card) belongs to the recovery surface, NOT this file.
 *
 * Single-durable-writer rule per resolution: when the card is live
 *   in-process, ApprovalManager.resolveApproval settles it and the manager's
 *   settle hook writes the durable clear + approval_resolved event —
 *   opResolveApproval does NOT double-write. Only the not-live path writes
 *   here directly.
 */
import { readOp } from "../ops/op-store.js";
import { getApprovalManager, type ApprovalDenyReason } from "../approval-manager.js";
import { writeSignalColumn } from "./control-api.js";
import { emit } from "./event-emitter.js";
import type { PendingApprovalRecord } from "./types.js";

/**
 * Durably record an op-scoped approval ask: write the pendingApproval signal
 * column (latest-wins) and append the `approval_requested` canonical event.
 * No-op for unknown ops — a non-op-scoped ask simply has no durable shadow.
 */
export function recordApprovalRequested(opId: string, record: PendingApprovalRecord): void {
  const op = readOp(opId);
  if (!op) return;
  // OP-9: merge onto the LATEST disk state under the per-op lock so a
  // concurrent pause/cancel/redirect from another writer is preserved.
  writeSignalColumn(opId, op, (c) => { c.pendingApproval = record; });
  emit(opId, "approval_requested", {
    approvalId: record.approvalId,
    toolName: record.toolName,
  });
}

export interface ApprovalResolution {
  approvalId: string;
  toolName: string;
  approved: boolean;
  /** Set on every approved:false resolution (see ApprovalDenyReason). */
  reason?: ApprovalDenyReason;
}

/**
 * Durably record an approval settlement: clear the pendingApproval column
 * (only when it still belongs to THIS approvalId — a newer ask must not be
 * clobbered) and append the `approval_resolved` canonical event. No-op for
 * unknown ops.
 */
export function recordApprovalResolved(opId: string, res: ApprovalResolution): void {
  const op = readOp(opId);
  if (!op) return;
  writeSignalColumn(opId, op, (c) => {
    if (c.pendingApproval?.approvalId === res.approvalId) c.pendingApproval = null;
  });
  emit(opId, "approval_resolved", {
    approvalId: res.approvalId,
    toolName: res.toolName,
    approved: res.approved,
    ...(res.reason !== undefined ? { reason: res.reason } : {}),
  });
}

export interface ApprovalControlOk {
  ok: true;
  /**
   * "delivered" — the card was live in-process: the waiting tool call's
   *   promise settled and the manager's settle hook wrote the durable
   *   clear + event.
   * "recorded"  — the card was NOT live (post-restart): the decision is
   *   durably recorded (column cleared + approval_resolved appended) but no
   *   in-process waiter consumed it. The recovery re-drive's fresh re-ask is
   *   what actually acts on it — see the header comment.
   */
  delivery: "delivered" | "recorded";
}
export interface ApprovalControlErr {
  ok: false;
  code: "invalid_op_id" | "invalid_approval_id" | "unknown_op" | "unknown_approval";
  message: string;
}
export type ApprovalControlResult = ApprovalControlOk | ApprovalControlErr;

/**
 * Resolve an op-scoped approval card (PRD §13-style control entrypoint —
 * mirrors opPause/opCancel shape: validate, durable write, canonical event).
 *
 * Live path: delegates to ApprovalManager.resolveApproval — the promise the
 * tool call is awaiting settles, and the manager writes the durable clear +
 * `approval_resolved` (single durable writer per resolution).
 *
 * Not-live path (process restarted since the ask): clears the durable column
 * + appends `approval_resolved`, and returns `delivery: "recorded"` so the
 * caller knows the decision landed on disk but was not delivered to a
 * waiting tool call.
 */
export function opResolveApproval(
  opId: string,
  approvalId: string,
  approved: boolean,
  rememberForSession = false,
): ApprovalControlResult {
  if (typeof opId !== "string" || opId.length === 0) {
    return { ok: false, code: "invalid_op_id", message: "opId must be a non-empty string" };
  }
  if (typeof approvalId !== "string" || approvalId.length === 0) {
    return { ok: false, code: "invalid_approval_id", message: "approvalId must be a non-empty string" };
  }
  const op = readOp(opId);
  if (!op) return { ok: false, code: "unknown_op", message: `no op with id ${opId}` };

  if (getApprovalManager().resolveApproval(approvalId, approved, rememberForSession)) {
    return { ok: true, delivery: "delivered" };
  }

  const pending = op.canonical?.pendingApproval;
  if (!pending || pending.approvalId !== approvalId) {
    return {
      ok: false,
      code: "unknown_approval",
      message: `op ${opId} has no live or recorded pending approval ${approvalId}`,
    };
  }
  recordApprovalResolved(opId, {
    approvalId,
    toolName: pending.toolName,
    approved,
    ...(approved ? {} : { reason: "declined" as const }),
  });
  return { ok: true, delivery: "recorded" };
}
