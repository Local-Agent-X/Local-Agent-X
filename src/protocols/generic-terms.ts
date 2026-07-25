/**
 * Terms that carry no topical information — the one source of truth for
 * "this word does not tell us what the request is ABOUT".
 *
 * Two consumers, both making an ADMISSION decision (is this request about this
 * protocol?) rather than a ranking one:
 *   - learned-suggestion.ts  — coverage of the user's distinctive terms
 *   - search.ts              — the relevance gate on protocol(action:'search')
 *
 * It lives in its own leaf file because those two modules cannot import each
 * other: `learned-suggestion.ts` imports `./index.js`, which imports
 * `./search.js`, so a direct import would close a cycle. A leaf with no imports
 * of its own is importable from anywhere, and keeps the sets singular — the
 * alternative (a second copy in search.ts) is exactly the drift this repo keeps
 * paying for.
 *
 * The test for membership, applied when adding a word: does it say what KIND of
 * action is wanted rather than WHAT it is about? "create", "task", "workflow"
 * do. "deploy", "research", "slack", "brownfield" do not — they are the subject.
 * Adding a word here weakens every consumer's evidence for that word
 * simultaneously, so each addition needs a measured defect behind it, not a
 * plausible story.
 */

/** Function words. Present in every sentence; distinguish nothing. */
export const STOP_TERMS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "by", "can", "do",
  "for", "from", "how", "i", "in", "into", "is", "it", "me", "my", "of",
  "on", "or", "our", "please", "that", "the", "then", "this", "to", "we",
  "what", "when", "with", "you", "your",
]);

/**
 * Domain-generic words. These are about the SHAPE of the request — the kind of
 * artefact or the kind of action — and appear across unrelated protocols, so a
 * match on one is not evidence that a protocol is about the request.
 *
 * `create` and `make` were added by chunk I1, each with the measured defect that
 * motivated it, against the real catalog and against a catalog holding no
 * purchasing protocol at all:
 *   create — `create purchase order` returned `git_workflow` (2.32), because
 *            "create a branch" is one of git_workflow's own trigger phrases.
 *   make   — `make a new purchase order` returned `instagram_post` (5.16),
 *            because "make an instagram post" is one of ITS trigger phrases.
 * In both cases the matched word was a real, deliberate part of the protocol's
 * identity. It was still not evidence about the subject of the request.
 *
 * ADDING A WORD HERE IS NOT A ONE-WAY TIGHTENING — it pulls the two consumers
 * in OPPOSITE directions, which is why each addition has to be measured in
 * both. In search.ts it removes evidence, so admission gets stricter. In
 * learned-suggestion.ts the term also leaves the coverage DENOMINATOR, so every
 * remaining match counts for more and admission gets LOOSER. Two candidates
 * were tried and reverted for exactly that: `update` moves the pinned aside
 * `"update the release notes file and publish the post"` from 2/6 = 0.333 to
 * 2/5 = 0.400, over MIN_COVERAGE; `new` moves `"post the new product photos to
 * instagram with a caption"` from 2/6 to 2/5 for `facebook_post`, breaking the
 * tier test that pins nothing else being suggested. `add` / `run` / `get` /
 * `set` are not here because no measured defect calls for them — and a word
 * added on a plausible story rather than a measurement is how the two reverts
 * above happened.
 *
 * Consequence worth stating rather than hiding: because `new` cannot be added,
 * `make a new purchase order` still matches `app-build` on "new". The class of
 * residual is bounded, not eliminated — a request whose only catalog-matchable
 * word is generic can still surface a weak hit, and closing the last of them
 * would mean breaking retrieval in the other consumer.
 */
export const GENERIC_TERMS = new Set([
  "active", "agent", "automatic", "coding", "create", "handle", "learned",
  "make", "process", "protocol", "request", "task", "use", "using", "workflow",
]);

/** True when a term is a function word or domain-generic — i.e. it cannot, on
 *  its own, be evidence that a protocol is about the request. */
export function isTopicallyEmpty(term: string): boolean {
  return STOP_TERMS.has(term) || GENERIC_TERMS.has(term);
}
