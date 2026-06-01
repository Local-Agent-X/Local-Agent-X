/**
 * Result-shape guard for agent terminal state.
 *
 * Caught a live failure: the Deep Researcher hit two HTTP 404/500 web
 * fetches mid-task, bailed early, and emitted "I don't currently have
 * the actual research question/topic in this chat thread. Please send
 * the topic." The handler runtime then marked the run `done` (no
 * exception thrown, no merge conflict) — so a 300-char clarification
 * request quietly counted as success in History.
 *
 * Agents in the canonical model don't have conversations. They get one
 * task at spawn and either complete it or report a structured blocker.
 * Anything in the result that reads like "ask the user to resend the
 * task" is a failure, not a success — and the storage layer should say
 * so loudly. This guard catches the most common phrasings.
 *
 * Heuristic, not perfect: false positives are acceptable (rare, and
 * the user can re-run); false negatives leave us where we were
 * (quietly broken runs). Tuned for high recall on real agent
 * clarification-asks.
 */

/** Phrases an agent uses when it gave up and asked the user to repeat
 *  itself. Case-insensitive. Hit-list curated from the gravity failure
 *  + related shapes. */
const CLARIFICATION_PHRASES: ReadonlyArray<RegExp> = [
  /please send (the|me) (topic|task|goal|question)/i,
  /please (re)?send the (topic|task|goal|question)/i,
  /please (provide|share|give me) the (topic|task|goal|question)/i,
  /i don'?t (currently )?have the (actual )?(research )?(question|topic|task|goal)/i,
  /could you (clarify|specify|provide|share|tell me)/i,
  /can you (clarify|specify|provide|share|tell me)/i,
  /what (would you like|do you want|did you want) me to/i,
  /which (topic|task|goal|question)/i,
  /i'?m not sure what you'?(re| are) asking/i,
  /the (task|topic|question) (is unclear|wasn'?t clear|was unclear)/i,
];

/** Look at the LAST 500 chars for phrase matches. Bail-outs end with
 *  "please send the topic" regardless of preamble length; a real
 *  completed report would end with conclusions or recommendations.
 *  This catches both the short "I don't have the topic" case AND the
 *  long-preamble-then-bail case where the agent rambled before asking
 *  for clarification at the end. */
const TAIL_WINDOW_CHARS = 500;

export interface GuardVerdict {
  isClarificationRequest: boolean;
  /** The matching phrase pattern when triggered. Useful for the
   *  error message stored on the run record so the user can see what
   *  the guard caught. */
  matchedPhrase?: string;
}

/** Committing-action verbs/assertions an agent uses to claim it changed
 *  state — save/create/write/commit/delete/update/install/send plus the
 *  "done"/"complete"/✅ family. TIGHT on purpose: only verbs that imply a
 *  mutation. Read-only verbs (analyzed, found, researched, reviewed,
 *  recommend) are deliberately absent so genuine research reports never
 *  fire. Case-insensitive. */
const COMMITTING_CLAIM_PHRASES: ReadonlyArray<RegExp> = [
  /\b(saved|created|wrote|committed|deleted|removed|updated|installed|sent)\b/i,
  /✅/,
  /\b(all )?done\b/i,
  /\b(task |everything )?(is )?complete(d|ly)?\b/i,
];

export interface CompletionGuardVerdict {
  isUnsubstantiated: boolean;
  /** The matching phrase pattern when triggered. Stored on the run record
   *  so the user can see which committing-action claim was caught. */
  matchedPhrase?: string;
}

/**
 * Returns whether the result looks like the agent gave up and asked
 * for clarification instead of completing the task.
 *
 * Logic: scan the tail of the result (last 500 chars) for known
 * clarification phrases. The tail is what matters — a real completed
 * report ends with conclusions or recommendations, not a "please send"
 * request. Tail-only scanning keeps false-positives down for long
 * reports that mention clarification language in narrative ("the
 * data team could clarify the cohort definitions...") in the middle.
 */
export function looksLikeClarificationRequest(result: string): GuardVerdict {
  if (typeof result !== "string" || result.length === 0) {
    return { isClarificationRequest: false };
  }
  const tail = result.length <= TAIL_WINDOW_CHARS
    ? result
    : result.slice(-TAIL_WINDOW_CHARS);
  for (const pattern of CLARIFICATION_PHRASES) {
    const match = tail.match(pattern);
    if (match) {
      return { isClarificationRequest: true, matchedPhrase: match[0] };
    }
  }
  return { isClarificationRequest: false };
}

/**
 * Returns whether the result claims a committing action (saved, created,
 * wrote, etc.) without the agent having actually run a successful committing
 * tool. `committedWork` is the authoritative ledger signal from the canonical
 * runner — when true this guard never fires. When false, the tail of the
 * result is scanned for a committing-action claim; a hit means the agent
 * narrated work it never committed (a false completion).
 *
 * Tail-only and a tight verb list keep false-positives near-zero: a real
 * research/analysis report that only "analyzed", "found", or "recommended"
 * carries no committing verb, so it stays a success.
 */
export function looksLikeUnsubstantiatedCompletion(
  result: string,
  committedWork: boolean,
): CompletionGuardVerdict {
  if (committedWork === true) return { isUnsubstantiated: false };
  if (typeof result !== "string" || result.length === 0) {
    return { isUnsubstantiated: false };
  }
  const tail = result.length <= TAIL_WINDOW_CHARS
    ? result
    : result.slice(-TAIL_WINDOW_CHARS);
  for (const pattern of COMMITTING_CLAIM_PHRASES) {
    const match = tail.match(pattern);
    if (match) {
      return { isUnsubstantiated: true, matchedPhrase: match[0] };
    }
  }
  return { isUnsubstantiated: false };
}
