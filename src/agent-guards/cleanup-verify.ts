// Cleanup-verify — the task is a removal/cleanup sweep ("remove all X", "finish
// cleaning up Y", "migrate off Z") and the model is reporting it DONE, but
// nothing this op confirmed the target is actually gone. The sibling of
// verify-gate: that guards "edited source but never built"; this guards
// "claimed a removal done but never re-searched to confirm zero matches". A
// removal is verified by a SEARCH that comes back empty, not by a build — dead
// references in comments, docs, strings, config, and tests compile fine.
//
// The proof is read from the model's OWN grep output already in the op — grep
// emits the literal "No matches found." when a pattern has zero hits, in every
// output mode (rg path and the Node fallback alike) — so no tool is re-run from
// inside the loop. The orchestrator owns dispatch; a middleware only inspects
// what already ran.
//
// Logic lives here (pure, testable); the canonical middleware in
// src/canonical-loop/middlewares/cleanup-verify.ts feeds it per-turn grep
// results and reads the verdict for the terminal-outcome label.

/** Minimal view of one tool result — structurally a subset of the canonical
 *  CanonicalToolResultView, kept local so this pure guard doesn't reach up into
 *  the canonical-loop layer. */
export interface CleanupToolResult {
  toolName: string;
  content: string;
  status?: "ok" | "error" | "cancelled";
  /** The grep's search pattern, when known. Lets the gate track cleanliness PER
   *  pattern: an empty result for a narrow pattern must not vouch for a broader
   *  one that still matches. Absent → an anonymous single bucket (legacy). */
  pattern?: string;
}

export interface CleanupVerifyState {
  /** At least one (non-errored) grep ran this op. */
  searchedAny: boolean;
  /** Normalized patterns whose MOST RECENT grep still returned matches. A
   *  pattern stays here until a later grep for it comes back empty. The bug this
   *  fixes: a single empty grep used to latch "clean" forever, so a broad search
   *  that kept matching never revoked the verdict — the model "verified" a narrow
   *  pattern (already gone) and claimed the broad one clean. */
  outstanding: string[];
  /** Derived: every searched pattern is currently empty (the removal is proven).
   *  Kept as a field so callers can read it straight after noteCleanupEvidence. */
  confirmedClean: boolean;
  /** Verdict for the terminal-outcome label: a cleanup reported done without a
   *  clean search. Recomputed each wrap-up so a post-nudge re-grep that comes
   *  back empty flips it false (recovery). */
  unverified: boolean;
  /** Fire-once cap — one nudge per op, matching the other wrap-up guards. */
  fired: boolean;
}

export function createCleanupVerifyState(): CleanupVerifyState {
  return { searchedAny: false, outstanding: [], confirmedClean: false, unverified: false, fired: false };
}

/** Anonymous bucket for a grep whose pattern wasn't threaded through (legacy /
 *  test callers). Real wiring always supplies the pattern. */
const ANON_PATTERN = "__anon__";

/** Canonicalize a grep pattern into a stable key. Simple `a|b|c` alternations
 *  are sorted so a reordered-but-equivalent search shares the bucket (avoids a
 *  spurious "still outstanding" when the model re-greps with the branches in a
 *  different order). Anything with regex structure is matched verbatim. */
export function normalizeGrepPattern(pattern?: string): string {
  if (!pattern) return ANON_PATTERN;
  const t = pattern.trim().toLowerCase();
  if (!t) return ANON_PATTERN;
  if (/^[^()\\[\]{}.*+?^$]*\|[^()\\[\]{}.*+?^$]*$/.test(t)) {
    return t.split("|").map(s => s.trim()).filter(Boolean).sort().join("|");
  }
  return t;
}

// A removal/cleanup verb. Narrower than broad-sweep's find-and-change set: only
// changes whose DONE state is "the thing is gone", which an empty search can
// confirm. add/rename/refactor are excluded — a clean grep doesn't prove those.
const REMOVAL_CUE =
  /\b(?:remov\w*|delet\w*|deprecat\w*|rip(?:ping|ped)?\s+out|get(?:ting)?\s+rid\s+of|migrat\w*\s+(?:off|away|from)|purg\w*|eliminat\w*|scrub\w*|strip(?:ping|ped)?\s+out|cleanup|clean(?:ing|ed)?\s*-?\s*up|finish\s+(?:cleaning|removing|deleting))\b/i;

// Breadth: the removal spans more than one named spot, so "is it gone?" is a
// project-wide search, not a single-file delete. "references to X", "from this
// project", "all/every/everywhere" all qualify.
const TARGET_BREADTH =
  /\b(?:all|every|everywhere|throughout|scattered|left\s*over|remaining|references?|refs?|usages?|mentions?|occurrences?|across\s+the\s+\w+|from\s+(?:the|this)\s+(?:project|code\s*base|codebase|repo(?:sitory)?|app|code)|in\s+the\s+(?:project|code\s*base|codebase|repo(?:sitory)?|app|code))\b/i;

/** True when the task reads as a project-wide removal/cleanup whose completion
 *  an empty search can confirm (needs BOTH a removal verb and a breadth cue).
 *  Pure + exported for direct testing. */
export function looksLikeCleanupSweep(task: string): boolean {
  const t = (task || "").trim();
  if (t.length < 12) return false;
  return REMOVAL_CUE.test(t) && TARGET_BREADTH.test(t);
}

/** grep emits exactly this sentinel when a pattern has zero matches, in every
 *  output mode. Anchored so a content-mode line that merely contains the phrase
 *  can't be mistaken for an empty result. */
export function isEmptyGrepResult(content: string): boolean {
  return /^\s*No matches found\.?\s*$/i.test(content);
}

// A wrap-up that ASSERTS the cleanup is finished ("Cleanup complete", "all
// references removed", "no tailnet code remains"). Used only to decide whether
// the gate's nudge should also RETRACT the bubble — an unverified done-claim is
// a confirmed-false statement the next turn supersedes, so it shouldn't stand.
const COMPLETION_CLAIM =
  /\b(?:complete(?:d|ly)?|finished|all\s+(?:set|clear|done|removed|gone|cleaned)|fully\s+(?:removed|cleaned|migrated|gone)|no\s+(?:\w+\s+){0,4}(?:references?|refs?|mentions?|usages?|occurrences?|code|tailnet|tailscale|imports?)\s+(?:remain|left|exist)|nothing\s+(?:left|remain)|all\s+done|done)\b/i;

// Negation / incompleteness markers. An HONEST "not done / still remain /
// partial" wrap-up must NOT be retracted (it's the truthful state we want kept),
// so any of these present cancels the retract — erring toward keeping text.
const NEGATION =
  /n['’]t|\b(?:not|cannot|unable|incomplete|partial|still\s+(?:remain|present|need|have|left|exist|to)|not\s+yet|remaining|some\s+(?:remain|left)|more\s+(?:to|remain))\b/i;

/** True when the wrap-up text positively asserts the cleanup is finished, with
 *  no negation — i.e. a confirmed-false done-claim worth retracting. */
export function claimsCleanupDone(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return COMPLETION_CLAIM.test(t) && !NEGATION.test(t);
}

/** Fold one turn's tool results into the running state. Per grep pattern, the
 *  MOST RECENT result wins: empty clears that pattern, matches mark it
 *  outstanding. The cleanup is confirmed clean only when every searched pattern
 *  is currently empty — so a narrow empty grep can't vouch for a broad pattern
 *  that still has hits. */
export function noteCleanupEvidence(
  results: CleanupToolResult[],
  state: CleanupVerifyState,
): void {
  for (const r of results) {
    if (r.toolName !== "grep" || r.status === "error") continue;
    state.searchedAny = true;
    const key = normalizeGrepPattern(r.pattern);
    if (isEmptyGrepResult(r.content)) {
      state.outstanding = state.outstanding.filter(p => p !== key);
    } else if (!state.outstanding.includes(key)) {
      state.outstanding.push(key);
    }
  }
  state.confirmedClean = state.searchedAny && state.outstanding.length === 0;
}

/** Evaluate at wrap-up. Refreshes the terminal-label verdict (every call) and
 *  returns a one-time nudge when a cleanup is being reported done without a
 *  confirming search. */
export function checkCleanupVerify(state: CleanupVerifyState): { nudge: string | null } {
  state.confirmedClean = state.searchedAny && state.outstanding.length === 0;
  state.unverified = !state.confirmedClean;
  if (state.confirmedClean || state.fired) return { nudge: null };
  state.fired = true;
  const hadMatches = state.outstanding.length > 0;
  return {
    nudge:
      "You're reporting this cleanup as done, but nothing this run has confirmed " +
      "the target is actually gone. A removal isn't finished until a fresh search " +
      "comes back empty — a passing build doesn't count, since dead references in " +
      "comments, docs, strings, config, and tests all compile fine. " +
      (hadMatches
        ? "Your last search for it STILL returned matches — an empty result for a " +
          "narrower or differently-scoped pattern does NOT prove the broader target " +
          "is gone. Go fix the remaining hits, then re-run the SAME broad search. "
        : "Re-run `grep` across the WHOLE project for the thing you removed (and its " +
          "aliases / old names). ") +
      "If ANY references remain, finish them, then re-grep. Only report it done once " +
      "the search returns no matches. If you're trusting a memory or a note that says " +
      "it's already done, don't — verify against the actual code now.",
  };
}
