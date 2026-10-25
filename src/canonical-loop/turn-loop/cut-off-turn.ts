/**
 * A turn the OUTPUT LIMIT ended — split out of decide-outcome.ts, beside
 * empty-turn-termination.ts.
 *
 * A provider stop of `length` / `max_tokens` means the reply was cut off, not
 * finished. With no tool call in it, the adapter still reports "done" from
 * the turn's SHAPE (text, nothing outstanding), and the op ended as a success
 * having done nothing: on Terminal-Bench 7 of 9 local-model runs thought
 * until the context was full and stopped there (2026-10-18).
 *
 * So a cut-off turn with no tool call is re-driven with a nudge to act, at
 * most CUT_OFF_REDRIVE_LIMIT times in a row, and its committed text is cut
 * down to its tail: the next request carries the whole history, and a
 * runaway draft fed back in full would fill the window again. Past the limit
 * the turn ends with an honest terminal instead of a silent "done".
 *
 * Each re-drive also gets twice the output room of the reply before it
 * (cutOffRedrivesInARow → TurnInput.cutOffRedrives → local-cap.ts). A local
 * thinking model's reasoning counts against the output cap, and qwen3.8 on
 * hard derivations thinks past 16k tokens before its first tool call: with the
 * same cap and its reasoning gone, every re-drive started the same thought
 * over and was cut at the same place, 4-5 times in a row (6 of 37
 * Terminal-Bench tasks, 2026-10-25).
 */
import { getMiddlewareState } from "../middlewares/state.js";
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";
import { appendNudgeAsUserMessage } from "./nudges.js";

const CUT_OFF_TURN_KEY = "cut-off-turn-counter";
export const CUT_OFF_REDRIVE_LIMIT = 2;
/** How much of a cut-off draft stays in history. */
export const CUT_OFF_KEPT_CHARS = 2_000;
export const CUT_OFF_NUDGE =
  "Your last reply hit the output limit and was cut off before you made a tool call or finished. Do not restate the plan: take the next concrete step now with one tool call, then continue from its result.";
export const CUT_OFF_TERMINAL =
  "I ran out of output room before acting, several times in a row, so the task is not done. The model kept writing past its output limit without making a tool call.";

/** Stops that mean the provider cut the reply off at its output limit. */
const CUT_OFF_STOPS = new Set(["length", "max_tokens", "max_output_tokens"]);

export function isCutOffStop(stop: string | undefined): boolean {
  return !!stop && CUT_OFF_STOPS.has(stop.toLowerCase());
}

export interface CutOffTurnInput {
  op: Op;
  turnIdx: number;
  providerStop?: string;
  toolCalls: ToolCall[];
  terminalReason: "done" | "error" | null;
  middlewareAborted: boolean;
  middlewareSuspended: boolean;
}

/**
 * Both verdicts mean the caller commits the draft through trimCutOffText:
 *   "redrive"   → re-open the turn. The nudge is best-effort: when the op's
 *                 nudge budget is spent it is refused, and the trimmed
 *                 draft's own marker still says what to do next. Before, a
 *                 refused nudge left the full draft in history and the next
 *                 request outgrew the window (cad-model, 2026-10-19).
 *   "exhausted" → CUT_OFF_REDRIVE_LIMIT re-drives in a row are spent; end
 *                 the turn with CUT_OFF_TERMINAL.
 *   null        → not a cut-off turn, or one another decision already owns.
 */
export function evaluateCutOffTurn(in_: CutOffTurnInput): "redrive" | "exhausted" | null {
  const state = getMiddlewareState(in_.op.id, CUT_OFF_TURN_KEY, () => ({ consecutive: 0 }));
  const cutOff = isCutOffStop(in_.providerStop) && in_.toolCalls.length === 0;
  if (!cutOff) { state.consecutive = 0; return null; }
  // An adapter error, a middleware abort or a suspend decided this turn.
  if (in_.terminalReason === "error" || in_.middlewareAborted || in_.middlewareSuspended) return null;
  if (state.consecutive >= CUT_OFF_REDRIVE_LIMIT) return "exhausted";
  appendNudgeAsUserMessage(in_.op.id, in_.turnIdx + 1, CUT_OFF_NUDGE,
    { name: "cut-off-turn", reason: "cut-off-turn", outcome: "nudge" });
  state.consecutive += 1;
  return "redrive";
}

/** How many cut-off re-drives in a row the op's next turn follows; 0 when its
 *  last turn was not cut off. */
export function cutOffRedrivesInARow(opId: string): number {
  return getMiddlewareState(opId, CUT_OFF_TURN_KEY, () => ({ consecutive: 0 })).consecutive;
}

/** The tail of a cut-off draft, marked as such, for the committed history. */
export function trimCutOffText(text: string): string {
  if (text.length <= CUT_OFF_KEPT_CHARS) return text;
  return `[This reply was cut off at the output limit before any tool call; only its last ${CUT_OFF_KEPT_CHARS} characters are kept. Continue by making the next tool call.]\n…${text.slice(-CUT_OFF_KEPT_CHARS)}`;
}
