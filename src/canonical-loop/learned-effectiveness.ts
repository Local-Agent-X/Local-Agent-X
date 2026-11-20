import type { Op } from "../ops/types.js";
import { readOp } from "../ops/op-store.js";
import {
  commitLearnedOutcome,
  prepareLearnedOutcome,
  readLearnedOutcome,
  reconcilePendingLearnedOutcomes,
  type LearnedOutcome,
  type LearnedOutcomeReceipt,
} from "../protocols/learned-effectiveness.js";
import { getLearnedProtocolEnvelopeForOp } from "./runtime.js";

export function prepareCanonicalLearnedOutcome(
  op: Op,
  outcome: LearnedOutcome,
  sessionId: string,
): LearnedOutcomeReceipt | null {
  const envelope = getLearnedProtocolEnvelopeForOp(op.id);
  // A prior transition attempt may have prepared the receipt and then failed
  // after terminal cleanup removed the envelope. Reuse that exact receipt on
  // retry so the now-durable terminal state can still commit it.
  if (!envelope) {
    const existing = readLearnedOutcome(op.id);
    if (existing && existing.outcome !== outcome) {
      throw new Error(`Pending learned outcome does not match terminal result for ${op.id}`);
    }
    return existing;
  }
  return prepareLearnedOutcome({
    opId: op.id,
    sessionId,
    slug: envelope.slug,
    versionId: envelope.versionId,
    candidateId: envelope.candidateId,
    outcome,
    timestamp: Date.now(),
  });
}

export function commitCanonicalLearnedOutcome(op: Op, receipt: LearnedOutcomeReceipt): void {
  commitLearnedOutcome(receipt.opId);
}

export function reconcileCanonicalLearnedOutcomes(): ReturnType<typeof reconcilePendingLearnedOutcomes> {
  return reconcilePendingLearnedOutcomes(readOp, Date.now());
}
