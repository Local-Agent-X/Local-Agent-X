import { contentWords } from "../memory/text-utils.js";

/**
 * Detect short conversational follow-ups — acks, vague pronouns, "what
 * happened" / "why" / "really" style replies that reference the prior
 * turn rather than asking a new substantive question. On these, the
 * orchestrator drops high-bleed-risk signal categories so prior-
 * conversation memory doesn't confabulate the answer.
 */
export function isConversationalFollowup(message: string): boolean {
  const m = (message || "").trim().toLowerCase();
  if (!m) return false;
  const wordCount = m.split(/\s+/).length;
  if (wordCount > 8) return false;
  // Pure acks / yes-no / single-word
  if (/^(yes|yeah|yep|yup|ok|okay|sure|sounds good|got it|cool|nice|thanks|ty|nope|no|nah|fine|alright)[.!?]*$/i.test(m)) return true;
  // Short "what / why / how / really / huh" follow-ups
  if (wordCount <= 6 && /^(what|why|how|when|where|who|really|huh|wait|hm+|hmm+|oh|wow)\b/i.test(m)) return true;
  // Pronoun-anchored short reactions ("yeha what happened", "what does that mean", "tell me more")
  if (wordCount <= 8 && /\b(it|that|this|those|them|happened|going on|going|mean|tell me more|continue|go on|keep going)\b/i.test(m)) return true;
  return false;
}

/**
 * Cheap topical-relevance check — extracts substantive keywords from
 * both the user's current message and a candidate signal, returns true
 * only if they share 2+ keywords. Used to gate high-bleed signal
 * categories on substantive (non-followup) messages: a signal about
 * "logo work for baddies-and-daddies" should NOT inject when the user
 * is writing about their AI journey story doc — zero keyword overlap,
 * filter drops it. The keywords are memory's content words (text-utils.ts) of
 * four letters or more; in a script with no spaces between syllables, any length.
 */
// Exported for the bleed-gate regression test in
// test/orchestrator-resume-bleed.test.ts. Internal callers still hit the
// same function — exporting just unlocks unit-level coverage of the
// deterministic fallback path.
export function topicalKeywords(text: string): Set<string> {
  return new Set(contentWords(text || "", 4));
}

export function signalTopicallyRelevant(messageWords: Set<string>, signalText: string): boolean {
  const sigWords = topicalKeywords(signalText);
  let overlap = 0;
  for (const w of sigWords) {
    if (messageWords.has(w)) {
      overlap++;
      if (overlap >= 2) return true;
    }
  }
  return false;
}
