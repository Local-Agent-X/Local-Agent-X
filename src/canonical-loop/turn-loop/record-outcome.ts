/**
 * Terminal-outcome recording for one op (PRD §15 completion ledger).
 *
 * Split out of decide-outcome.ts so both the normal turn-loop path and the
 * MAX_TURNS truncation path in worker.ts can record an op's outcome under its
 * tool-derived category without either file forking the categorization logic.
 */
import type { Op } from "../../ops/types.js";
import { readOpTurns } from "../store.js";
import { resolveOpModel } from "../op-model.js";
import { classifyOpCategory, recordOpOutcome, type OpOutcome } from "../../tool-tracker.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import crossSessionLearner from "../../cognition/cross-session-learning/index.js";

export type { OpOutcome };

/**
 * Record the op's terminal outcome under its tool-derived category. The category
 * spans every tool the op touched across all committed turns (plus any extras
 * observed this turn), so an op that ends tool-lessly still classifies right.
 * Shared with the MAX_TURNS truncation path in worker.ts: a force-terminated op
 * transitions straight to failed, skipping the turn-loop, so without recording
 * here it would escape the outcome ledger entirely (the completion metric went
 * blind to every truncated run).
 */
export function recordTerminalOutcome(
  op: Op,
  outcome: OpOutcome,
  extraToolNames: Iterable<string> = [],
): void {
  const toolSequence = collectToolSequence(op.id, extraToolNames);
  const category = classifyOpCategory(new Set(toolSequence));
  recordOpOutcome(category, outcome, resolveOpModel(op));
}

function collectToolSequence(opId: string, extraToolNames: Iterable<string> = []): string[] {
  const toolSequence: string[] = [];
  for (const turn of readOpTurns(opId)) {
    for (const s of turn.toolCallSummary ?? []) toolSequence.push(s.tool);
    for (const t of turn.observedTools ?? []) toolSequence.push(t);
  }
  for (const t of extraToolNames) toolSequence.push(t);
  return toolSequence;
}

/** Persist learning evidence only after commitTurn succeeds. Unlike aggregate
 *  telemetry, learned evidence must never observe a provisional terminal state:
 *  cancellation and commit failure can still invalidate it. */
export function recordCommittedLearningOutcome(op: Op, outcome: OpOutcome, sessionId: string): void {
  const toolSequence = collectToolSequence(op.id);
  const category = classifyOpCategory(new Set(toolSequence));
  const model = resolveOpModel(op);
  crossSessionLearner.recordOutcome({
    opId: op.id,
    sessionId,
    outcome,
    category,
    tools: toolSequence,
    model,
    timestamp: Date.now(),
  });
}

/** Capture before terminal commit releases the live session binding. */
export function resolveLearningSessionId(op: Op): string {
  // An op id is unique work identity, not conversation provenance. Keep the
  // session unknown when no live binding exists so later distinct-session
  // confidence cannot count detached ops as separate conversations.
  return getSessionForOp(op.id) ?? "";
}
