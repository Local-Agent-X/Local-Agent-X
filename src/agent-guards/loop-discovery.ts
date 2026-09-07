/**
 * Exploration-waste detectors — the two loop signals that watch READ-ONLY
 * work: re-running one search forever, and spinning on one discovery tool.
 *
 * Split out of loop-detection.ts when cycle detection landed and pushed that
 * file past the 400-LOC ceiling. Sibling to loop-progress.ts (which owns "did
 * anything change?") and post-commit.ts; loop-detection.ts remains the single
 * entry point that sequences all of them against the one LoopState. Nothing
 * here holds state of its own — counters live on LoopState and are passed in,
 * so there is still exactly one per-op state object.
 *
 * SPIRALABLE_TOOLS and the thresholds are re-exported by loop-detection.ts so
 * existing importers (agent-guards/index.ts, the fence test) keep their path.
 */
import { normalizeGrepPattern } from "./cleanup-verify.js";
import { parseToolArgs } from "./loop-progress.js";

// Read-only discovery / lookup tools an agent spins on when it can't find
// something. No risk-taxonomy tier models "discovery spin", so this stays a
// curated list — but every member MUST be read-only (a fence test in
// loop-detection.test.ts asserts risk in {safe, network-read}), so a mutating
// tool can never be mistaken for a harmless lookup. Worker-pool status checks
// (op_status / op_wait / agent_status) get polled in a tight loop — a chat
// agent polled op_status 16x in one turn — so they're spiralable too.
//
// Mutation / progress classification (which tools reset the no-progress and
// discovery counters) lives in tool-mutation-check.ts, derived from the risk
// taxonomy. Only this discovery set is curated.
export const SPIRALABLE_TOOLS = new Set([
  "glob", "web_search", "read", "grep",
  "agent_whoami", "agent_team_list", "issue_list", "issue_search",
  "memory_search", "memory_recall", "memory_get",
  "task_list",
  "op_status", "op_wait", "agent_status", "agent_output",
]);

/** Tools whose repeated identical SEARCH (the pattern, not the call bytes) is
 *  the waste signal. Curated + read-only, like SPIRALABLE_TOOLS. */
const REPEAT_SEARCH_TOOLS = new Set(["grep", "web_search"]);

// Re-running the SAME search this many times is redundant: the answer won't
// change without an intervening edit, and even with edits between, re-
// confirming one broad pattern over and over is waste. Generous so a careful
// grep->fix->grep convergence (which narrows the pattern as it goes) isn't
// tripped; the weak floor catches models that loop harder. Re-nudges every few
// repeats past the limit, routing through the caller's lifetime ceiling.
const REDUNDANT_SEARCH_LIMIT = 8;
const REDUNDANT_SEARCH_LIMIT_WEAK = 5;
const REDUNDANT_SEARCH_RENUDGE = 4;

const DISCOVERY_LOOP_THRESHOLD = 8;
const DISCOVERY_LOOP_THRESHOLD_WEAK = 4;

export function searchLimitFor(weak: boolean): number {
  return weak ? REDUNDANT_SEARCH_LIMIT_WEAK : REDUNDANT_SEARCH_LIMIT;
}

export function discoveryLimitFor(weak: boolean): number {
  return weak ? DISCOVERY_LOOP_THRESHOLD_WEAK : DISCOVERY_LOOP_THRESHOLD;
}

/** A stable key for "the same search", or null for a non-search call. Keys on
 *  the search PATTERN/QUERY (normalized), NOT the full args — so a re-grep
 *  with a different glob/scope still collapses to one key. */
export function searchKeyOf(name: string, argsJson: string): string | null {
  if (!REPEAT_SEARCH_TOOLS.has(name)) return null;
  const args = parseToolArgs(argsJson);
  if (!args) return null;
  const raw = typeof args.pattern === "string" ? args.pattern
    : typeof args.query === "string" ? args.query
    : null;
  if (!raw) return null;
  return `${name}:${normalizeGrepPattern(raw)}`;
}

/**
 * Count this turn's searches and report one that has crossed the redundancy
 * limit, or null. Counts by normalized PATTERN and never resets on progress,
 * so it catches the diffuse re-search the discovery-loop detector can't see
 * (edits between greps + varied globs keep that one resetting).
 *
 * Mutates the caller's counter map — that map is the op's LoopState field, so
 * the count survives across turns exactly as it did inline.
 */
export function checkRedundantSearch(
  toolCalls: Array<{ name: string; arguments: string }>,
  searchKeyCounts: Map<string, number>,
  weak: boolean,
): { term: string; count: number } | null {
  const limit = searchLimitFor(weak);
  let hit: { term: string; count: number } | null = null;
  for (const tc of toolCalls) {
    const sk = searchKeyOf(tc.name, tc.arguments);
    if (!sk) continue;
    const n = (searchKeyCounts.get(sk) || 0) + 1;
    searchKeyCounts.set(sk, n);
    if (n >= limit && (n - limit) % REDUNDANT_SEARCH_RENUDGE === 0) {
      hit = { term: sk.slice(sk.indexOf(":") + 1), count: n };
    }
  }
  return hit;
}

/** The spiralable tool whose call count has crossed the discovery limit, or
 *  null. Read-only: the caller resets the counter when it acts on the hit. */
export function findDiscoveryLoop(
  toolNameCounts: Map<string, number>,
  weak: boolean,
): { tool: string; count: number } | null {
  const limit = discoveryLimitFor(weak);
  for (const [name, count] of toolNameCounts) {
    if (count >= limit && SPIRALABLE_TOOLS.has(name)) return { tool: name, count };
  }
  return null;
}

/** Pivot-toward-action wording for a discovery spin. The model usually has
 *  enough context by call N — what it needs is permission to switch tactics,
 *  not an instruction to give up. */
export function discoveryNudge(tool: string, count: number): string {
  const hint = (tool === "read" || tool === "glob" || tool === "grep")
    ? " You have enough context — switch tactic: use write/edit/bash to act on what you've already read, or ask the user a focused question if you're truly stuck."
    : " You have enough context — produce the answer or take the next concrete action.";
  return `SYSTEM: ${tool} called ${count} times this turn — that's a discovery loop signal.${hint} Do not call ${tool} again unless you have a specific new file/path/term to look up.`;
}

/** Wording for the redundant-search hit. */
export function redundantSearchNudge(term: string, count: number): string {
  return `SYSTEM: you've run the same search (${term}) ${count}x this op — re-running it won't change the answer. Stop re-searching: act on the matches you already have (edit the files), or if the search came back clean, move on. Re-run the search only ONCE after you've actually changed files, to confirm.`;
}
