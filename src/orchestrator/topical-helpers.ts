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
 * filter drops it.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "have", "will", "your", "you",
  "but", "are", "was", "were", "been", "what", "when", "where", "who", "why", "how",
  "can", "would", "could", "should", "about", "into", "onto", "than", "then", "them",
  "they", "their", "there", "here", "just", "like", "make", "made", "want", "wanted",
  "really", "much", "many", "more", "most", "some", "all", "also", "still", "only",
  "tell", "told", "saying", "said", "thing", "things", "going", "got", "get", "getting",
  "ill", "im", "ive", "dont", "wont", "didnt", "isnt", "arent", "wasnt", "werent", "cant",
]);

// Exported for the bleed-gate regression test in
// test/orchestrator-resume-bleed.test.ts. Internal callers still hit the
// same function — exporting just unlocks unit-level coverage of the
// deterministic fallback path.
export function topicalKeywords(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w)),
  );
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
