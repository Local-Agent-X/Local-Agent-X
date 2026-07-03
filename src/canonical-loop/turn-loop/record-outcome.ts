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
  const opToolNames = new Set<string>();
  for (const turn of readOpTurns(op.id)) {
    for (const s of turn.toolCallSummary ?? []) opToolNames.add(s.tool);
    for (const t of turn.observedTools ?? []) opToolNames.add(t);
  }
  for (const t of extraToolNames) opToolNames.add(t);
  recordOpOutcome(classifyOpCategory(opToolNames), outcome, resolveOpModel(op));
}
