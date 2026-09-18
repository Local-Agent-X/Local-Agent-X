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
import { appendNudgeAsUserMessage } from "./nudges.js";
import { narrationPromisesFollowup } from "./p1-followup-detector.js";

/**
 * Per-op key for the interactive fully-empty-turn counter, held in the same
 * per-op middleware-state registry the worker retry counters use (keyed by
 * op.id, auto-dropped on op terminal — see middlewares/state.ts). Counts
 * CONSECUTIVE fully-empty interactive turns so the terminator can allow one
 * silent re-drive and then stop, instead of spinning to maxTurns. Not new
 * global state and needs no field threaded through op state.
 */
const INTERACTIVE_EMPTY_TURN_KEY = "interactive-empty-turn-counter";

/** Consecutive reasoning-only turns (thinking, then no text and no tool call). */
const REASONING_ONLY_TURN_KEY = "interactive-reasoning-only-counter";
const REASONING_ONLY_LIMIT = 2;
export const REASONING_ONLY_NUDGE =
  "Your last turn ended after thinking, with no answer and no tool call. Continue from your plan: make the tool call you intended, or give your answer.";

/**
 * The same rule as REASONING_ONLY, for the variant where the plan arrives as
 * ANSWER text instead of reasoning: the model says what it is about to do and
 * ends the turn having done nothing. The user is left with "Let me search the
 * workspace for it." and no search (muse, op-outcomes find-project).
 *
 * Kept deliberately hard to trip, because a finished answer may also contain
 * "I'll": it fires only when the op has dispatched NO tool at all, the reply is
 * a single short sentence (or a bare command line), it promises a next action,
 * and it is not a question back to the user.
 * One nudge per op — if the model says it again, that is its answer.
 */
const ANNOUNCED_ONLY_TURN_KEY = "interactive-announced-only-counter";
// A bare announcement is ONE short sentence ("Let me search the workspace for
// it."). A real answer that happens to promise something carries the answer
// with it and runs longer or into a second sentence — the discriminator is the
// shape, not the length alone, because a 197-char reply that named exactly
// which files it would delete tripped a length-only rule in test.
const ANNOUNCED_ONLY_MAX_CHARS = 90;
const COMMAND_MAX_CHARS = 300;
export const ANNOUNCED_ONLY_NUDGE =
  "Your last turn described a command or an intention but made no tool call, so nothing ran. Make the tool call now, then answer from its result.";

/**
 * The other half of the same stall: the reply IS the command, typed out as
 * prose instead of called. muse answered find-project with
 * `bash -c "Get-ChildItem -Recurse -Filter *CRM* ..."` and stopped.
 *
 * Recognizing this can only ever produce a NUDGE — never a promoted call. The
 * text extractor deliberately refuses to execute a bare command string
 * (tool-call-text-syntaxes.ts: a truncated call must not run), and that
 * invariant is not weakened here; the model is asked to make the call itself.
 *
 * One line, one leading command word, and an argument that looks like a flag,
 * a quoted string or a path — prose that merely mentions a command has a
 * sentence around it and fails the single-line test.
 */
const COMMAND_STARTERS = /^`?(?:bash|sh|zsh|powershell|pwsh|cmd|python3?|node|npm|npx|git|ls|dir|cat|grep|rg|find|glob|read|write|edit|curl)\b/i;
const COMMAND_ARGUMENT = /\s(?:-{1,2}[a-z]|["'`/~]|[A-Za-z]:[\\/])/i;

export function isBareCommandReply(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > COMMAND_MAX_CHARS) return false;
  if (t.includes("\n")) return false;
  return COMMAND_STARTERS.test(t) && COMMAND_ARGUMENT.test(t);
}

/** Sentences in a reply — a bare announcement is exactly one. */
function sentenceCount(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length;
}

export function isAnnouncedOnlyReply(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (isBareCommandReply(t)) return true;
  if (t.length > ANNOUNCED_ONLY_MAX_CHARS || sentenceCount(t) > 1) return false;
  if (t.endsWith("?")) return false; // asking the user, not stalling
  return narrationPromisesFollowup(t);
}

export interface AnnouncedOnlyTurnInput {
  op: Op;
  turnIdx: number;
  assistantText: string;
  toolCalls: ToolCall[];
}

/**
 * True when this turn should be re-driven instead of ending: the model
 * announced an action, made no call, and the op has done nothing at all. The
 * nudge is queued here, so a false return (budget spent, already used once)
 * means the turn ends as it otherwise would.
 *
 * Called by decide-outcome BEFORE the done gate — the gate would terminate a
 * tool-less turn with text, and a terminal decision is never taken back.
 */
export function redriveAnnouncedOnlyTurn(in_: AnnouncedOnlyTurnInput): boolean {
  const { op, assistantText, toolCalls } = in_;
  if (op.lane !== "interactive") return false;
  // Called on EVERY interactive turn so the op's own tool history is tracked
  // here rather than threaded through the turn input.
  const state = getMiddlewareState(op.id, ANNOUNCED_ONLY_TURN_KEY, () => ({ used: false, sawTool: false }));
  if (toolCalls.length > 0) { state.sawTool = true; return false; }
  if (state.sawTool || state.used) return false;
  if (!isAnnouncedOnlyReply(assistantText)) return false;
  const nudged = appendNudgeAsUserMessage(op.id, in_.turnIdx + 1, ANNOUNCED_ONLY_NUDGE,
    { name: "announced-only", reason: "announced-only", outcome: "nudge" });
  if (nudged) state.used = true;
  return nudged;
}

export interface EmptyInteractiveTurnInput {
  op: Op;
  turnIdx: number;
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
    const noOutput = assistantText.trim().length === 0 && toolCalls.length === 0;
    const fullyEmpty = noOutput && !hasReasoning;
    const emptyState = getMiddlewareState(op.id, INTERACTIVE_EMPTY_TURN_KEY, () => ({ consecutive: 0 }));
    const thinkingState = getMiddlewareState(op.id, REASONING_ONLY_TURN_KEY, () => ({ consecutive: 0 }));
    if (!(noOutput && hasReasoning)) thinkingState.consecutive = 0;
    if (noOutput && hasReasoning && terminalReason === null) {
      // The model thought and stopped without an answer or a tool call. Ask
      // it to act on its plan; re-driving the same input would repeat the
      // same turn. Bounded: a second consecutive one, or a spent nudge
      // budget, ends the turn honestly.
      thinkingState.consecutive += 1;
      const nudged = thinkingState.consecutive < REASONING_ONLY_LIMIT
        && appendNudgeAsUserMessage(op.id, in_.turnIdx + 1, REASONING_ONLY_NUDGE,
          { name: "reasoning-only", reason: "reasoning-only", outcome: "nudge" });
      if (!nudged) {
        terminalReason = "done";
        thinkingState.consecutive = 0;
        emptyInteractiveTerminal = { signaledDone: false };
      }
    }
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
  appendHonestTerminal(opId, turnIdx, allMessages, text, "empty-turn");
}

/**
 * THE append for a harness-authored terminal assistant message: publish it as
 * a live delta and push it onto the commit list. Shared by the empty-turn
 * terminator above and the completion gates' `honestTerminal` (decide-outcome
 * appends the latter after the chain settles). `idPrefix` names the source in
 * the message id.
 */
export function appendHonestTerminal(
  opId: string,
  turnIdx: number,
  allMessages: CommitTurnMessage[],
  text: string,
  idPrefix: string,
): void {
  publishStreamChunk(opId, { delta: text });
  allMessages.push({
    messageId: `${idPrefix}-${opId}-${turnIdx}-${randomUUID().slice(0, 6)}`,
    role: "assistant",
    content: { text },
  });
}
