/**
 * The words of a text, for everything in memory and cognition that searches,
 * compares or counts them. One split rule (splitWords) and the stop-word lists
 * live here; a caller picks the tokenizer whose job matches its own:
 *   - tokenizeBasic: every word of length ≥ 3, stop words included.
 *     Fact-merge dedup and tier query-match, where stop words carry signal.
 *   - tokenizeStrict: the same, minus the words that carry no claim.
 *     Fact-overlap checks, where "the/and/is" would dominate Jaccard.
 *   - contentWords: the same, minus STOP_WORDS (conversational filler too).
 *     Search keywords, topics and labels, where "please" and "thanks" are noise.
 *
 * Plus jaccardSimilarity, which works on any Iterable<string>.
 *
 * These were four stop-word lists and six split rules, most of them ASCII-only:
 * a message in Hindi reached memory search as one syllable, and two unrelated
 * Russian facts both split into no words at all, which Jaccard reads as identical.
 */

/** Scripts whose every character is a syllable or a morpheme: a two-character
 *  word in them (서울, 東京) carries meaning the way a long Latin word does. */
const SYLLABIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** A text's words, lowercased, in any script: its runs of letters, marks and
 *  digits. Marks are part of a word: splitting on them cuts a Hindi, Thai or
 *  vowelled Arabic word into single letters, which every length filter then
 *  drops. (The index's unicode61 tokenizer does split at some marks. A search
 *  term is quoted, so the index splits it the way it split the stored text.) */
export function splitWords(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

/** A word long enough to mean something: `minLength` characters, or any length
 *  in a syllabic script. */
function longEnough(word: string, minLength: number): boolean {
  return word.length >= minLength || SYLLABIC.test(word);
}

/** Words that carry no claim. Kept short on purpose: tokenizeStrict decides
 *  whether two facts say the same thing, and "need", "only" or "still" can be
 *  the whole difference between them. */
const STRICT_STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","at","by","to","in","on","for","is","are","was","were",
  "be","been","being","have","has","had","do","does","did","this","that","these","those","i","you",
  "he","she","it","we","they","my","your","his","her","its","our","their","me","him","us","them",
  "not","no","so","up","out","as","with","from","about","into","over","under","also","then","than",
]);

/**
 * Words that say nothing about what a text is about: the claimless words above
 * (so a word tokenizeStrict drops is never a keyword), the rest of English's
 * function words, light verbs, and conversational filler. The one list for
 * search keywords, topics, compression and the atlas's labels.
 *
 * A contraction arrives as its halves ("didn't" is "didn" and "t"), so the
 * halves are listed, and the forms people type without the apostrophe. "don",
 * "won" and "ill" are absent: a name and two words people search for.
 */
export const STOP_WORDS = new Set([
  ...STRICT_STOPWORDS,
  "can", "could", "doing", "done", "get", "got", "getting", "having", "here", "hers",
  "herself", "himself", "how", "itself", "just", "let", "like", "ll", "may", "might",
  "myself", "nor", "ours", "ourselves", "own", "re", "same", "shall", "should",
  "some", "such", "theirs", "themselves", "there", "through", "too", "ve", "very",
  "what", "when", "where", "which", "while", "who", "whom", "whose", "why", "will",
  "would", "yours", "yourself", "yourselves",
  "above", "after", "again", "all", "already", "am", "any", "because", "before",
  "below", "between", "both", "dare", "during", "each", "even", "every", "few",
  "further", "many", "more", "most", "much", "must", "need", "now", "off", "once",
  "only", "onto", "other", "ought", "quite", "since", "still", "yet",
  "going", "know", "made", "make", "really", "right", "said", "say", "saying",
  "tell", "thing", "things", "think", "told", "use", "used", "using", "want",
  "wanted", "well", "went",
  "hello", "hey", "hi", "ok", "okay", "please", "sure", "thank", "thanks", "uh",
  "um", "yeah", "yes",
  "aren", "couldn", "didn", "doesn", "hadn", "hasn", "isn", "shouldn", "wasn",
  "weren", "wouldn", "arent", "cant", "didnt", "dont", "isnt", "wasnt", "werent", "wont",
]);

/** Every word of length ≥ 3 (any length in a syllabic script), stop words included. */
export function tokenizeBasic(text: string): string[] {
  return splitWords(text).filter((w) => longEnough(w, 3));
}

/** The words that can carry a claim: tokenizeBasic's, minus the claimless ones. */
export function tokenizeStrict(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of splitWords(text)) {
    if (longEnough(w, 3) && !STRICT_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** The words a text is about, in order and with repeats: no STOP_WORDS, and
 *  nothing shorter than `minLength` outside a syllabic script. */
export function contentWords(text: string, minLength = 3): string[] {
  return splitWords(text).filter((w) => longEnough(w, minLength) && !STOP_WORDS.has(w));
}

/**
 * Jaccard similarity = |A ∩ B| / |A ∪ B|.
 * Returns 1 when both empty, 0 when exactly one is empty.
 */
export function jaccardSimilarity(a: Iterable<string>, b: Iterable<string>): number {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
