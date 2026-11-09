/**
 * Spoken approvals: when a tool on a call needs the user's OK, LAX asks out
 * loud and the user's next words answer it, the way a click answers the card
 * in a typed chat.
 *
 * The question is built from the call's own approval line (the same text the
 * card shows, buildApprovalContext), never from the model's words, so a "yes"
 * approves what will actually run. The answer is read strictly: only a short,
 * plainly affirmative reply approves; anything with a no in it declines; an
 * unclear reply is asked once more, then declined. Silence declines when the
 * answer window closes.
 *
 * Before this, every approval on a call was declined unasked (2026-11-09): a
 * spoken turn could not send, buy, or run anything that needed an OK.
 */
import { getApprovalManager } from "../approval-manager.js";

export type SpokenAnswer = "yes" | "no" | "unclear";

/** How long the user has to answer before the ask is declined. */
export const ANSWER_WINDOW_MS = 45_000;

const MAX_YES_WORDS = 6;
const MAX_CONTEXT_CHARS = 160;

/** A reply approves only when it holds one of these... */
const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|ok|okay|alright|absolutely|definitely|approved?|confirm(ed)?|go ahead|do it|send it|go for it|sounds good|please do|of course)\b/;
/** ...and every word in it is one of these (so "yes, but change it" is not a yes). */
const YES_WORDS = new Set([
  "yes", "yeah", "yep", "yup", "ya", "sure", "ok", "okay", "alright", "all", "right", "absolutely",
  "definitely", "approve", "approved", "confirm", "confirmed", "go", "ahead", "do", "it", "send",
  "for", "sounds", "good", "great", "please", "of", "course", "that's", "thats", "fine", "perfect",
  "thanks", "thank", "you", "works",
]);
const NEGATIVE = /\b(no|nope|nah|don'?t|do not|not|stop|cancel|wait|hold on|hold off|never|negative)\b/;
/** A yes said as an answer, as opposed to an action named ("don't send it"):
 *  next to a no, it makes the reply unclear. */
const ANSWER_YES = /\b(yes|yeah|yep|yup|sure|ok|okay|alright|absolutely|definitely|of course)\b/;

/** Read the user's spoken reply to an approval question. */
export function classifySpokenAnswer(text: string): SpokenAnswer {
  const lower = text.toLowerCase().replace(/[’]/g, "'");
  const words = lower.replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
  const yes = AFFIRMATIVE.test(lower) && words.length <= MAX_YES_WORDS && words.every((w) => YES_WORDS.has(w));
  const no = NEGATIVE.test(lower);
  if (yes && !no) return "yes";
  if (no) return ANSWER_YES.test(lower) ? "unclear" : "no";
  return "unclear";
}

/** The question spoken for an approval, from the call's approval line. */
export function approvalQuestion(context: string): string {
  const line = context.replace(/\s+/g, " ").trim().replace(/[.:;,\s]+$/, "");
  const said = line.length > MAX_CONTEXT_CHARS ? `${line.slice(0, MAX_CONTEXT_CHARS).trimEnd()}…` : line;
  return ` That needs your OK: ${said}. Should I go ahead?`;
}

export const ASK_AGAIN = " Sorry, should I go ahead? Yes or no.";

export interface SpokenApprovalDeps {
  /** Speak a line on the call (it also enters the turn's stored text). */
  speak: (line: string) => void;
  /** The user's next words, or null when the window closes, the turn ends, or
   *  `cancel` fires. Absent where the session has nobody to answer (dictate). */
  awaitAnswer?: (timeoutMs: number, cancel: AbortSignal) => Promise<string | null>;
  /** Ends the turn's asks (a barge-in, a typed message replacing the turn). */
  turnSignal: AbortSignal;
  log: (line: string) => void;
  resolve?: (approvalId: string, approved: boolean) => boolean;
}

/** The asks of one spoken turn: raise one per approval_requested, and stop
 *  waiting on one that was settled elsewhere (its card answered, or timed out). */
export function createSpokenApprovals(deps: SpokenApprovalDeps) {
  const resolve = deps.resolve ?? ((id, approved) => getApprovalManager().resolveApproval(id, approved));
  const waiting = new Map<string, AbortController>();

  async function ask(approvalId: string, context: string, toolName: string): Promise<void> {
    if (!deps.awaitAnswer || deps.turnSignal.aborted) {
      resolve(approvalId, false);
      return;
    }
    const cancel = new AbortController();
    waiting.set(approvalId, cancel);
    const onTurnEnd = () => cancel.abort();
    deps.turnSignal.addEventListener("abort", onTurnEnd, { once: true });
    try {
      deps.speak(approvalQuestion(context));
      let answer = classifyOrNull(await deps.awaitAnswer(ANSWER_WINDOW_MS, cancel.signal));
      if (answer === "unclear") {
        deps.speak(ASK_AGAIN);
        answer = classifyOrNull(await deps.awaitAnswer(ANSWER_WINDOW_MS, cancel.signal));
      }
      // Settled elsewhere: resolve is a no-op on a settled ask. Turn ended
      // (barge-in, a typed message): nobody said yes, so it is declined.
      const approved = !cancel.signal.aborted && answer === "yes";
      deps.log(`[voice-ws] spoken approval for ${toolName}: ${cancel.signal.aborted ? "ended unanswered" : answer ?? "no answer"}`);
      resolve(approvalId, approved);
    } finally {
      waiting.delete(approvalId);
      deps.turnSignal.removeEventListener("abort", onTurnEnd);
    }
  }

  return {
    requested(event: { approvalId: string; context: string; toolName: string }): void {
      void ask(event.approvalId, event.context, event.toolName);
    },
    settled(approvalId: string): void {
      waiting.get(approvalId)?.abort();
    },
  };
}

function classifyOrNull(text: string | null): SpokenAnswer | null {
  return text === null ? null : classifySpokenAnswer(text);
}
