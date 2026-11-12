/**
 * How deep research is done: the one written method. The researcher role
 * (agent-roles.ts), the Deep Researcher template (agent-store/template-defaults.ts)
 * and a collab member researching at depth "deep" (collab-messages.ts) all
 * carry this text, so "deep" means one thing.
 *
 * It is instructions for the agent loop, not a loop of its own: the loop that
 * runs it is the canonical one (agents/invoke.ts, or a chat's turn).
 */

/** The loop and the report. Ends without a claims list: each user adds its own
 *  (`DEEP_RESEARCH_CLAIMS` below, or the collab's line format the app reads). */
export const DEEP_RESEARCH_METHOD =
  "Work as an iterative loop, not a single search.\n" +
  "1. PLAN: break the question into sub-questions and state what a complete answer must cover.\n" +
  "2. SEARCH WIDE: issue several distinct queries at once using web_search's `queries` param (fan-out), then read the most relevant pages with web_fetch. A search snippet is not a source: cite only pages you opened.\n" +
  "3. ASSESS GAPS & SOURCES: after each round, compare what you have against your plan — what's still missing, thin, or backed by only one source? Also weigh each source's reliability (primary/official > reputable secondary > anonymous or SEO filler); discount or replace weak sources rather than repeating their claims. Sources that repeat one origin (a press release, a wire story) count as one source. Check the date on anything that changes over time and prefer the newest. Run another round targeting only those gaps. Stop when the plan is covered or a round yields no new facts.\n" +
  "4. VERIFY before reporting: for each load-bearing claim, actively try to refute it — search for the criticism or the counter-evidence, and find a second independent source. If you can't corroborate it, mark it unverified rather than asserting or silently dropping it.\n" +
  "5. REPORT — structure the output as a report, not a list of links:\n" +
  "   - Open with a one-paragraph executive summary of the key findings before the detail.\n" +
  "   - Organize the body into themed sections with `##` headers; write in connected prose, not bare bullet dumps.\n" +
  "   - Cite inline, right after the sentence each source supports — never a trailing 'Sources' pile. Prefer primary sources over commentary; cite more than one when they corroborate a load-bearing claim.\n" +
  "   - Surface conflicting sources explicitly with both sides, mark unverified claims as such, and date-stamp findings since web content changes.\n" +
  "   - Close with a short conclusion and concrete next steps or open questions.";

/** The closing claims list of a report nobody else will check line by line. */
export const DEEP_RESEARCH_CLAIMS =
  "   - End with a short list of the key claims, each marked confirmed (two or more independent sources), single-source, or disputed.";
