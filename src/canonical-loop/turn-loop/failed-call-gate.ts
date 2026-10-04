/**
 * Failed-call gate: a request may not end on a tool call that failed without
 * one more real attempt.
 *
 * The owner's ask (2026-10-03) was that every model keep going the way Claude
 * does. A Codex session showed the shape this closes: a call failed, and the
 * model's next turn handed the work back to the user ("send me a screenshot")
 * instead of trying another way. A prompt rule asks for follow-through; this
 * gate makes the turn continue.
 *
 * What it reads is the tool results, never the model's wording: the request's
 * LAST tool call (this turn's, else the latest earlier turn's in this op, which
 * is one user request) ended in an operational failure ("error" or "timeout")
 * and nothing succeeded after it. Then the turn reopens once, with a note
 * naming the tool. A policy outcome ("blocked", "declined") never fires it:
 * those are decisions (a security gate, the user saying no), and pushing for
 * "another way" past one would be the harness steering around its own guard.
 * Their refusals carry the honest next step themselves.
 *
 * Once per op: a second failure ends the turn as the model chose, so a call
 * that cannot succeed never loops.
 */
import { createLogger } from "../../logger.js";
import { readOpTurns } from "../store.js";
import { getMiddlewareState } from "../middlewares/state.js";
import type { ToolCallSummary } from "../types.js";
import type { CompletionGateContext } from "./decide-outcome-gate-contract.js";

const logger = createLogger("canonical-loop.failed-call-gate");

const FAILED_CALL_GATE_KEY = "failed-call-gate-fires";

/** Operational failures: the attempt went wrong, nothing decided against it. */
const OPERATIONAL_FAILURES: ReadonlySet<string> = new Set(["error", "timeout"]);

export function failedCallNudge(tool: string): string {
  return (
    `Your last tool call (\`${tool}\`) failed, and nothing after it succeeded, so the request may not be done. ` +
    `Before you end: try another way to do what that call was for (a different selector or route, a fresh look at the page, ` +
    `another source), or, if its result says it needs the user, tell them exactly what, and continue with any other part ` +
    `of the request. Do not repeat the same call unchanged.`
  );
}

/** The request's last tool call: this turn's last, else the latest earlier turn's. */
export function lastToolCall(current: readonly ToolCallSummary[], opId: string, turnIdx: number): ToolCallSummary | undefined {
  if (current.length > 0) return current[current.length - 1];
  const earlier = readOpTurns(opId).filter((t) => t.turnIdx < turnIdx && t.toolCallSummary.length > 0);
  const latest = earlier.reduce<(typeof earlier)[number] | undefined>((a, t) => (!a || t.turnIdx > a.turnIdx ? t : a), undefined);
  return latest?.toolCallSummary[latest.toolCallSummary.length - 1];
}

export interface FailedCallGateResult {
  nudge: string;
  shouldRetry: boolean;
}

export function runFailedCallGate({ op, turnIdx, toolSummary }: CompletionGateContext): FailedCallGateResult {
  const last = lastToolCall(toolSummary ?? [], op.id, turnIdx);
  if (!last || !OPERATIONAL_FAILURES.has(last.resultStatus)) return { nudge: "", shouldRetry: false };
  const state = getMiddlewareState(op.id, FAILED_CALL_GATE_KEY, () => ({ fires: 0 }));
  state.fires += 1;
  if (state.fires > 1) {
    logger.info(`op=${op.id} turn=${turnIdx} ended on a failed ${last.tool} call again after one retry — letting it end`);
    return { nudge: "", shouldRetry: false };
  }
  logger.info(`op=${op.id} turn=${turnIdx} is ending on a failed ${last.tool} call (${last.resultStatus}) — reopening once`);
  return { nudge: failedCallNudge(last.tool), shouldRetry: true };
}
