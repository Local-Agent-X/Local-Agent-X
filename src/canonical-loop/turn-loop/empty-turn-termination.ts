/**
 * Interactive fully-empty-turn terminator — the half of the empty-turn honesty
 * feature that lives in the turn loop, split out of decide-outcome.ts for the
 * 400-LOC source-hygiene ceiling. Sibling to ask-user-terminal.ts, which is the
 * other terminator decide-outcome delegates a sub-decision to.
 *
 * decide-outcome.ts keeps ownership of the terminal decision: it calls
 * evaluateEmptyInteractiveTurn at the same point it used to run this inline,
 * threading the CURRENT terminalReason in and taking the (possibly updated)
 * terminalReason back out, then defers appendEmptyTurnTerminal to after the
 * continuation guard + gate chain settle (re-checked against terminalReason so a
 * re-opened turn never commits a stale terminal). No parallel decision path.
 */
import { randomUUID } from "node:crypto";
import type { CommitTurnMessage } from "../checkpoint.js";
import { publishStreamChunk } from "../event-emitter.js";
import { getMiddlewareState } from "../middlewares/state.js";
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";

/**
 * Per-op key for the interactive fully-empty-turn counter, held in the same
 * per-op middleware-state registry the worker retry counters use (keyed by
 * op.id, auto-dropped on op terminal — see middlewares/state.ts). Counts
 * CONSECUTIVE fully-empty interactive turns so the terminator can allow one
 * silent re-drive and then stop, instead of spinning to maxTurns. Not new
 * global state and needs no field threaded through op state.
 */
const INTERACTIVE_EMPTY_TURN_KEY = "interactive-empty-turn-counter";

export interface EmptyInteractiveTurnInput {
  op: Op;
  assistantText: string;
  toolCalls: ToolCall[];
  hasReasoning: boolean;
  terminalReason: "done" | "error" | null;
  middlewareAborted: boolean;
  middlewareSuspended: boolean;
  modelSignaledDone: boolean;
}

export interface EmptyInteractiveTurnResult {
  terminalReason: "done" | "error" | null;
  emptyInteractiveTerminal: { signaledDone: boolean } | null;
}

/**
 * INTERACTIVE FULLY-EMPTY-TURN TERMINATOR. The main done-decision gate is
 * AND-gated on non-empty assistant text, so a FULLY-empty interactive turn (no
 * text after trim AND no tool calls AND no reasoning) leaves terminalReason=null
 * even when the model signaled end_turn — and the drive loop then re-drives the
 * SAME prompt with no nudge, burning iterations to a maxTurns checkpoint while
 * the app looks hung. This ends that spin HONESTLY, scoped tightly so it can
 * never truncate real work:
 *   - lane === "interactive" only (chat_turn + voice_turn). Worker lanes keep
 *     their existing behavior — their empty-response nudge lives in the
 *     post-turn-detector stack (gated when:isWorkerOp), untouched here.
 *   - "fully empty" is EXACTLY: assistantText.trim() empty AND no tool calls
 *     AND no reasoning. A tool-only turn (toolCalls.length>0) legitimately
 *     continues; a reasoning-only turn (hasReasoning) is the model thinking,
 *     not a hang — both are excluded so neither is cut off.
 *   - terminalReason still null: an adapter error, a middleware abort/suspend
 *     already decided this turn and must win, exactly as everywhere else.
 * Bounded via a per-op CONSECUTIVE-empty counter (auto-reset the moment a
 * non-empty interactive turn lands): the model may re-drive AT MOST ONCE, so
 * a transient blank gets a second shot without a nudge-storm, and a second
 * consecutive blank terminates. modelSignaledDone terminates on the first
 * empty turn — the model explicitly ended, so there is nothing to re-drive
 * for. The honest terminal message is deferred by the caller to after the
 * continuation guard + gate chain settle so a re-opened turn never shows it.
 */
export function evaluateEmptyInteractiveTurn(
  in_: EmptyInteractiveTurnInput,
): EmptyInteractiveTurnResult {
  const {
    op, assistantText, toolCalls, hasReasoning,
    middlewareAborted, middlewareSuspended, modelSignaledDone,
  } = in_;
  let terminalReason = in_.terminalReason;
  let emptyInteractiveTerminal: { signaledDone: boolean } | null = null;
  if (op.lane === "interactive" && !middlewareAborted && !middlewareSuspended) {
    const fullyEmpty =
      assistantText.trim().length === 0 && toolCalls.length === 0 && !hasReasoning;
    const emptyState = getMiddlewareState(op.id, INTERACTIVE_EMPTY_TURN_KEY, () => ({ consecutive: 0 }));
    if (!fullyEmpty) {
      emptyState.consecutive = 0;
    } else if (terminalReason === null) {
      emptyState.consecutive += 1;
      if (modelSignaledDone || emptyState.consecutive >= 2) {
        terminalReason = "done";
        emptyState.consecutive = 0;
        emptyInteractiveTerminal = { signaledDone: modelSignaledDone };
      }
      // First empty non-done turn: leave terminalReason=null → the loop
      // re-drives ONCE. The counter above bounds it to that single retry.
    }
  }
  return { terminalReason, emptyInteractiveTerminal };
}

/**
 * Surface an honest, brief terminal for an interactive turn that produced
 * nothing, rather than committing an empty assistant turn (which reads as a
 * hang). Mirrors appendQuestionAsAnswer's publish-delta + push-message shape.
 * Does NOT fabricate an answer: it states the true situation and stops.
 */
export function appendEmptyTurnTerminal(
  opId: string,
  turnIdx: number,
  allMessages: CommitTurnMessage[],
  signaledDone: boolean,
): void {
  const text = signaledDone
    ? "I don't have anything to add here."
    : "I wasn't able to produce a response — I appear to be blocked. Please try rephrasing or asking again.";
  publishStreamChunk(opId, { delta: text });
  allMessages.push({
    messageId: `empty-turn-${opId}-${turnIdx}-${randomUUID().slice(0, 6)}`,
    role: "assistant",
    content: { text },
  });
}
