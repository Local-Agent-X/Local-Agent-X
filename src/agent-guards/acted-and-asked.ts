// Acted-and-asked detector (Codex bias correction).
// Codex's RLHF heavily trained "ask if uncertain" behaviors that conflict
// with autonomous work. After making real edits, it often defaults back to
// "I'm missing the actual task context. What file should I modify?" — even
// though it just modified two files. Catch this and push back.

const QUESTION_AT_END_RE = /\?\s*$|\?\s*\n\s*$/;
const QUESTION_OPENERS_RE = /\b(what (file|app|should i|do you)|which (file|app|one)|do you want|please clarify|i'?m missing|missing.*context|need more (info|context|detail))\b/i;
const ACTION_TOOLS_FOR_ASKED = new Set(["write", "edit", "build_app", "self_edit"]);

/**
 * Detects "acted AND asked in the same turn" — the model made real edits
 * but ended its turn with a clarifying question instead of a summary.
 * Returns a nudge that pushes the model to either commit (summarize what
 * it did) or undo (and explain why), but not both.
 *
 * Returns null if:
 *   - No action tools were called this turn (just asking is fine)
 *   - The reply doesn't end in / open with a clarifying question
 *   - The reply already references what was done ("I just edited X, but
 *     I want to confirm Y" — that's legit confirmation, not drift)
 */
export function checkActedAndAsked(
  text: string,
  toolsCalledThisTurn: Set<string>,
): string | null {
  if (!text || text.length < 20) return null;
  const acted = [...ACTION_TOOLS_FOR_ASKED].filter(t => toolsCalledThisTurn.has(t));
  if (acted.length === 0) return null;

  const looksLikeQuestion = QUESTION_AT_END_RE.test(text) || QUESTION_OPENERS_RE.test(text);
  if (!looksLikeQuestion) return null;

  // Skip if the reply explicitly references the edits (legitimate confirmation)
  if (/\b(I (just |already )?(edited|wrote|modified|updated|changed)|the (edit|change|fix) (i|i've) (made|applied))\b/i.test(text)) {
    return null;
  }

  return (
    `You called ${acted.join(", ")} this turn — that's an action, not a question. ` +
    `Don't ask the user for more context after editing files. Pick ONE:\n` +
    `(1) FINISH: produce a 1-2 sentence summary of exactly what you changed and stop, OR\n` +
    `(2) UNDO: if your edits were wrong, revert them with a corresponding edit/write call and explain why you can't proceed.\n` +
    `Do not both act AND ask in the same turn.`
  );
}
