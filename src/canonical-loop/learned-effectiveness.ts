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
import { recordCommittedLearningOutcome } from "./turn-loop/record-outcome.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.learned-effectiveness");
let learningRecorder = recordCommittedLearningOutcome;

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

export function recordCanonicalLearningOutcome(
  op: Op,
  outcome: LearnedOutcome,
  sessionId: string,
  timestamp?: number,
): void {
  learningRecorder(op, outcome, sessionId, timestamp);
}

export function reconcileCanonicalLearnedOutcomes(
  recordOutcome: typeof recordCommittedLearningOutcome = learningRecorder,
): ReturnType<typeof reconcilePendingLearnedOutcomes> {
  return reconcilePendingLearnedOutcomes(readOp, Date.now(), (receipt) => {
    const op = readOp(receipt.opId);
    if (!op) return;
    try { recordOutcome(op, receipt.outcome, receipt.sessionId, receipt.timestamp); }
    catch (error) {
      logger.warn(`[learned-effectiveness] learner replay failed for ${receipt.opId}: ${(error as Error).message}`);
    }
  });
}

export function _setCanonicalLearningOutcomeRecorderForTests(
  recorder: typeof recordCommittedLearningOutcome = recordCommittedLearningOutcome,
): void {
  learningRecorder = recorder;
}
