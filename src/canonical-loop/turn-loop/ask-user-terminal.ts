/**
 * The ask_user terminal — the half of `ask_user` (src/tools/ask-user-tool.ts)
 * that lives in the turn loop.
 *
 * The tool itself only validates and echoes; it has no way to stop a turn.
 * Termination is decided in exactly one place (decide-outcome.ts), and every
 * terminator there asks "did the model FINISH?" — end_turn, an all-silent turn,
 * a committed mutation, no tools at all. None of them can see "the model is
 * BLOCKED on the user", so a question asked mid-turn was narration the loop
 * drove straight past: the agent asked, read back its own tool result, guessed,
 * and built on the guess (the live "production Clover token, or sandbox first?"
 * run). This module supplies the two pieces decide-outcome needs to end the turn
 * on the question instead: which questions were actually PUT to the user, and
 * how to make one of them the visible answer.
 *
 * Split out of decide-outcome.ts for the 400-LOC source-hygiene ceiling; sibling
 * to silent-tool-check.ts, which is the other per-tool input to termination.
 */
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../contract-types.js";
import type { CommitTurnMessage } from "../checkpoint.js";
import type { ToolCallSummary } from "../types.js";
import { publishStreamChunk } from "../event-emitter.js";

/** The tool whose successful call means "the user has to decide this one". */
export const ASK_USER_TOOL = "ask_user";

/**
 * Questions the agent actually PUT to the user this turn, in call order.
 *
 * Two proofs are required before a question counts, and both are already in
 * decide-outcome's scope — no new plumbing through the dispatch boundary:
 *   1. the call dispatched and SUCCEEDED — `toolSummary[i].resultStatus === "ok"`
 *      is the dispatch boundary's own verdict (ToolDispatchResult.status, see
 *      tool-dispatch.ts). A blocked (plan mode, policy), errored (blank
 *      question), or never-dispatched call must NOT end the turn.
 *   2. the question text — read off the call's args, exactly the way
 *      isSilentToolCall reads `browser.action`.
 * toolSummary is index-aligned with toolCalls (dispatch-tools.ts pushes one row
 * per call, in order) and may be SHORTER (cancel mid-batch, skipToolDispatch);
 * the per-index name cross-check makes a truncated list read as "did not run".
 *
 * Every ok'd question is collected, not just the first: a model that emits two
 * ask_user calls in one batch has asked the user two things, and dropping one
 * would end the turn showing a question the user was never given.
 */
export function collectAskedQuestions(
  toolCalls: ToolCall[],
  toolSummary: ToolCallSummary[],
): string[] {
  const out: string[] = [];
  toolCalls.forEach((call, idx) => {
    if (call.tool !== ASK_USER_TOOL) return;
    const summary = toolSummary[idx];
    if (!summary || summary.tool !== ASK_USER_TOOL || summary.resultStatus !== "ok") return;
    const question = (call.args as { question?: unknown } | null)?.question;
    if (typeof question !== "string" || !question.trim()) return;
    out.push(question.trim());
  });
  return out;
}

/**
 * Make the question the LAST thing the user sees, without destroying whatever
 * the model narrated alongside it. Same append pattern the terminal epilogue
 * uses (publish a delta, push one assistant message) rather than
 * replaceAssistantText — the narration is the model's own words, and a question
 * is an addition to them, not a correction of them. A question the model already
 * wrote out verbatim in its narration is skipped so it isn't shown twice.
 *
 * `delta` (not `{text}`) because every subscribeOpStream consumer forwards a
 * chunk only on a non-empty delta or `replace:true` — same reason the epilogue
 * publishes deltas.
 */
export function appendQuestionAsAnswer(
  opId: string,
  turnIdx: number,
  assistantText: string,
  questions: string[],
  allMessages: CommitTurnMessage[],
): void {
  const text = questions.filter(q => !assistantText.includes(q)).join("\n\n");
  if (!text) return;
  publishStreamChunk(opId, { delta: assistantText.trim().length > 0 ? `\n\n${text}` : text });
  allMessages.push({
    messageId: `ask-user-${opId}-${turnIdx}-${randomUUID().slice(0, 6)}`,
    role: "assistant",
    content: { text },
  });
}
