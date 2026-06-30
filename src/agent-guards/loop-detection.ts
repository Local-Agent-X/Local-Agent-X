// Tool-call loop detection. Three signals:
//   1. Exact-repeat: same {tool, args} N times in a row with UNCHANGED results
//      → abort.
//   2. Discovery loop: same READ-ONLY discovery tool (read/grep/glob/
//      web_search/...) called 8+ times with no new information → nudge.
//   3. No-progress: N iterations with no PROGRESS → abort.
//
// Progress (signals 2 + 3) is result-delta, not tool-identity: a turn made
// progress if it surfaced a tool result not seen before (the agent learned or
// changed something) OR it committed a mutation (isMutationTool — the floor
// that keeps fire-and-forget side effects like email_send from reading as a
// spin even when their ack is a constant string). A read returning new info is
// progress; a read/click returning the same bytes is not, regardless of the
// tool's class. The result-delta is the same sha1 signal the exact-repeat
// detector already uses, generalized across varied tools and across the op.
//
// Residual (intentional): a MUTATION-class tool that returns identical results
// forever (a dead-button browser click, an idempotent POST) still resets via
// the mutation floor and is NOT caught by no-progress — distinguishing it from
// a real constant-ack mutation (email_send) by result bytes alone would
// false-abort the latter. That spin is the exact-repeat detector's job (it's
// already result-aware) plus the per-op turn cap.
//
// Weak/medium models loop harder and faster, so thresholds halve when the
// caller passes modelTier="weak"|"medium".
//
// LoopState is exported because post-commit.ts reuses it — they share the
// per-op flag postCommitNudgePending so a commit detected by post-commit
// surfaces a nudge on the iteration after.

import { createHash } from "node:crypto";
import { logRetry } from "../retry-telemetry.js";
import { isMutationTool, isProgressTool } from "../tool-mutation-check.js";
import { normalizeGrepPattern } from "./cleanup-verify.js";

export interface LoopState {
  lastToolKey: string;
  sameToolCount: number;
  // Result-awareness for exact-repeat: a stuck model repeats the same call AND
  // gets the same result; a legitimate repeat (user asked for N identical runs,
  // polling a changing status, a retry that progresses) gets a DIFFERENT result
  // each time. lastResultSig is the signature of the last result for the
  // current repeated key; identicalResultRepeats counts consecutive repeats
  // that produced an unchanged result. Updated by noteToolResults() after
  // dispatch. Exact-repeat aborts only when these confirm non-progress.
  lastResultSig: string | null;
  identicalResultRepeats: number;
  toolNameCounts: Map<string, number>;
  // Result signatures (sha1) seen so far this op — the memory behind the
  // result-delta progress signal. A turn whose results are ALL already in here
  // surfaced nothing new. Insertion-ordered + FIFO-bounded (RESULT_SIG_MEMORY)
  // so a long op can't grow it without limit; an evicted-then-repeated result
  // only delays an abort, never causes a false one.
  seenResultSigs: Set<string>;
  // Whether the PRIOR turn surfaced a novel result. Set by noteToolResults
  // (post-dispatch, when results are known) and read by the next checkToolLoops
  // (pre-dispatch) — the same one-turn lag the exact-repeat detector runs on.
  lastTurnHadNovelResult: boolean;
  // Iterations elapsed since the last PROGRESS (a novel result OR a committed
  // mutation). Build_app worker spun 96 bash calls + 0 progress for 5 min
  // before kill. No-progress detector: if this exceeds NO_PROGRESS_LIMIT, abort.
  iterationsSinceProgress: number;
  // Set to true on the iteration AFTER a successful `git commit` is observed
  // in a bash tool result. Next iteration the agent gets a nudge to wrap up.
  // The perma-fix mandate keeps agents going past their commit; this caps it.
  postCommitNudgePending: boolean;
  // Per normalized SEARCH PATTERN, how many times it's been searched this op.
  // The discovery counter resets on any edit/novel-result, so a model that
  // re-runs ONE broad search between edits (with varied globs making each result
  // look novel) sails past it — one cleanup re-grepped a single pattern 26×,
  // burning ~40% of its turn budget before truncation. This counter keys on the
  // PATTERN and never resets on progress, so that diffuse waste is visible.
  searchKeyCounts: Map<string, number>;
  // Lifetime count of loop-break nudges emitted for this op. In the interactive
  // lane the abort paths downgrade to nudges (never kill a turn the user wants),
  // and each path resets its own window so it can't spam per-turn — but nothing
  // bounded the TOTAL: a model that ignored every nudge got re-nudged forever,
  // backstopped only by the wall-clock (up to 2h). Once this exceeds
  // NUDGE_CEILING we escalate to a hard abort even in the interactive lane —
  // six "you're looping, pivot" warnings is enough rope; past that it's a
  // runaway and ending the turn beats spinning. (The user keeps the chat and
  // can just send another message.)
  nudgeCount: number;
}

export function createLoopState(): LoopState {
  return {
    lastToolKey: "",
    sameToolCount: 0,
    lastResultSig: null,
    identicalResultRepeats: 0,
    toolNameCounts: new Map(),
    seenResultSigs: new Set(),
    lastTurnHadNovelResult: false,
    iterationsSinceProgress: 0,
    postCommitNudgePending: false,
    searchKeyCounts: new Map(),
    nudgeCount: 0,
  };
}

// Re-running the SAME search this many times is redundant: the answer won't
// change without an intervening edit, and even with edits between, re-confirming
// one broad pattern over and over is waste. Generous so a careful grep→fix→grep
// convergence (which narrows or changes the pattern as it goes) isn't tripped;
// the weak floor catches models that loop harder. Re-nudges every few repeats
// past the limit, routing through the lifetime ceiling like the other paths.
const REDUNDANT_SEARCH_LIMIT = 8;
const REDUNDANT_SEARCH_LIMIT_WEAK = 5;
const REDUNDANT_SEARCH_RENUDGE = 4;
// Tools whose repeated identical SEARCH (not the call bytes — the pattern) is
// the waste signal. Curated + read-only, like SPIRALABLE_TOOLS.
const REPEAT_SEARCH_TOOLS = new Set(["grep", "web_search"]);

/** A stable key for "the same search", or null for a non-search call. Keys on
 *  the search PATTERN/QUERY (normalized), NOT the full args — so a re-grep with
 *  a different glob/scope still collapses to one key. */
function searchKeyOf(name: string, argsJson: string): string | null {
  if (!REPEAT_SEARCH_TOOLS.has(name)) return null;
  let args: Record<string, unknown>;
  try { args = JSON.parse(argsJson) as Record<string, unknown>; } catch { return null; }
  const raw = typeof args.pattern === "string" ? args.pattern
    : typeof args.query === "string" ? args.query
    : null;
  if (!raw) return null;
  return `${name}:${normalizeGrepPattern(raw)}`;
}

// Cap on remembered result signatures (~50 bytes each → ~13 KB at the cap).
// Comfortably larger than NO_PROGRESS_LIMIT × a few results/turn, so a steady
// spin's signature stays resident across the whole no-progress window.
const RESULT_SIG_MEMORY = 256;

const DISCOVERY_LOOP_THRESHOLD = 8;
const DISCOVERY_LOOP_THRESHOLD_WEAK = 4;
// No-progress abort: iterations of consecutive non-mutating tool calls allowed
// before the agent is forced to end its turn. Raised from 12/6 → 25/15 after
// "research the latest tech in X and make a powerpoint" aborted at 6 web_search
// calls — research-then-build workflows legitimately need many read-only steps
// (web_search, web_fetch, snapshot, page extract, image search) before the
// first file write. The discovery-loop detector at DISCOVERY_LOOP_THRESHOLD
// still catches true spirals (8x identical tool); this guard is the backup
// for an agent that's genuinely stuck across many different tools.
export const NO_PROGRESS_LIMIT = 25;
export const NO_PROGRESS_LIMIT_WEAK = 15;
// Lifetime loop-break nudges allowed in the interactive lane before the detector
// stops nudging and hard-aborts the turn. Mirrors the repeat-failure middleware's
// NUDGE_AT/ABORT_AT escalation shape. Generous on purpose — each nudge already
// costs several turns to re-accumulate, so six of them spans many turns of the
// model being told to pivot and ignoring it. The wall-clock ceiling (up to 2h)
// is the only other backstop, so without this a stubborn loop ran far too long.
export const NUDGE_CEILING = 6;
// Read-only discovery / lookup tools an agent spins on when it can't find
// something. No risk-taxonomy tier models "discovery spin", so this stays a
// curated list — but every member MUST be read-only (a fence test in
// loop-detection.test.ts asserts risk ∈ {safe, network-read}), so a mutating
// tool can never be mistaken for a harmless lookup. Worker-pool status checks
// (op_status / op_wait / agent_status) get polled in a tight loop — a chat agent
// polled op_status 16x in one turn — so they're spiralable too.
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

/**
 * Check for exact-repeat loops and discovery loops. Weak/medium models
 * loop harder and faster than strong ones, so we halve the thresholds:
 * exact-repeat fires at 2x instead of 3x, discovery at 4 instead of 8.
 * Returns a nudge message if a loop is detected, or null.
 *
 * nudgeOnly downgrades the two abort paths (exact-repeat, no-progress) to a
 * nudge — for the interactive lane, where killing a turn out from under the
 * user is worse than letting a spin run one more cycle. The discovery path is
 * already nudge-only regardless.
 */
export function checkToolLoops(
  toolCalls: Array<{ name: string; arguments: string }>,
  state: LoopState,
  opts?: { modelTier?: "weak" | "medium" | "strong"; nudgeOnly?: boolean },
): { abort: boolean; nudge: string | null } {
  const isWeakOrMedium = opts?.modelTier === "weak" || opts?.modelTier === "medium";
  const repeatLimit = isWeakOrMedium ? 2 : 3;
  const discoveryLimit = isWeakOrMedium ? DISCOVERY_LOOP_THRESHOLD_WEAK : DISCOVERY_LOOP_THRESHOLD;

  // Every nudge below routes through here so the per-op lifetime ceiling can
  // bound a runaway. In the interactive lane (nudgeOnly), once the model has
  // been nudged past NUDGE_CEILING times and is STILL looping, stop nudging and
  // hard-abort the turn — the only other backstop is the 2h wall-clock. In the
  // worker lane the count still increments but never escalates here (workers
  // already hard-abort via the exact-repeat / no-progress paths).
  const emitNudge = (nudge: string): { abort: boolean; nudge: string | null } => {
    state.nudgeCount++;
    if (opts?.nudgeOnly && state.nudgeCount > NUDGE_CEILING) {
      logRetry({ kind: "loop-abort", tool: "nudge-ceiling", detail: { nudgeCount: state.nudgeCount, ceiling: NUDGE_CEILING, modelTier: opts?.modelTier } });
      return { abort: true, nudge: `SYSTEM: ending the turn — you've been told you're looping ${state.nudgeCount} times and kept going. Stopping now. Reply with what you have, or ask the user how to proceed.` };
    }
    return { abort: false, nudge };
  };

  // Exact-repeat detection. Aborts only when the repeated call ALSO keeps
  // producing the same result (confirmed via noteToolResults after each
  // dispatch) — so a user-requested batch of identical commands or a poll
  // whose result changes each turn isn't mistaken for a stuck spin. Detecting
  // non-progress needs ≥2 observed results, so the abort lands one turn later
  // than a result-blind check would; the no-progress + discovery guards below
  // remain the backstop for everything this misses.
  const key = toolCalls.map(tc => `${tc.name}:${tc.arguments}`).join("|");
  if (key === state.lastToolKey) {
    state.sameToolCount++;
    if (state.identicalResultRepeats >= repeatLimit - 1) {
      logRetry({ kind: "loop-abort", tool: toolCalls[0]?.name, detail: { repeatLimit, modelTier: opts?.modelTier, nudgeOnly: opts?.nudgeOnly ?? false } });
      if (opts?.nudgeOnly) {
        // Interactive chat: never kill the turn out from under the user. Break
        // the spin with a pivot nudge, then reset so it must re-accumulate
        // before nudging again (no per-turn spam if the model keeps spinning).
        // emitNudge escalates to a hard abort once the lifetime ceiling is hit.
        state.identicalResultRepeats = 0;
        return emitNudge(`SYSTEM: ${toolCalls[0]?.name} called with identical arguments and unchanged results ${state.sameToolCount}× — you're looping. Stop repeating it: take a different action, call a different tool, or answer with what you already have.`);
      }
      return { abort: true, nudge: "\n\n(Detected repeated tool calls with unchanging results — stopping loop)" };
    }
  } else {
    state.sameToolCount = 1;
    state.lastToolKey = key;
    state.identicalResultRepeats = 0;
    state.lastResultSig = null;
  }

  // Discovery-style loop detection: same READ-ONLY discovery tool (SPIRALABLE_
  // TOOLS, module scope) called 8+ times suggests the agent is spinning trying
  // to find something. Action tools (browser, http_request) are intentionally
  // NOT spiralable — they do progressive work and 8+ sequential calls is normal
  // multi-step automation, not a spiral. Exact-repeat detection above catches
  // true action loops.
  //
  // Two progress signals reset the spiralable counts: isProgressTool (local
  // work incl. bash — the audit-then-edit-then-verify pattern would otherwise
  // accumulate reads across phases and falsely trip the gate) and a novel
  // result from the PRIOR turn (the agent learned something new, so the prior
  // reads were exploration, not a spiral). A discovery tool spun on the SAME
  // result keeps neither signal, so its count climbs to the nudge. isProgressTool
  // derives from the risk taxonomy (tool-mutation-check.ts); the novelty signal
  // is the result-delta below. isMutationTool drives the no-progress counter.
  let madeProgress = false;
  let madeMutation = false;
  for (const tc of toolCalls) {
    if (isProgressTool(tc.name)) madeProgress = true;
    if (isMutationTool(tc.name)) madeMutation = true;
    state.toolNameCounts.set(tc.name, (state.toolNameCounts.get(tc.name) || 0) + 1);
  }
  if (madeProgress || state.lastTurnHadNovelResult) {
    // Reset only the spiralable counters — progress was made, the prior
    // reads were useful scaffolding, not a spiral. Keep non-spiralable
    // counts intact (they don't gate anything anyway).
    for (const name of SPIRALABLE_TOOLS) state.toolNameCounts.delete(name);
  }
  // No-progress detector: count iterations since the last PROGRESS — a
  // committed mutation (this turn) OR a novel result (the prior turn surfaced
  // information not seen before). Anything else (re-reading the same file,
  // git-status spin, a dead-button click whose page doesn't change) ticks.
  // When the counter exceeds NO_PROGRESS_LIMIT, abort — the agent is either
  // done (and stalling) or stuck (and spinning). madeMutation is this turn's
  // tool identity; lastTurnHadNovelResult is the prior turn's result-delta
  // (one-turn lag, same as the exact-repeat detector).
  if (madeMutation || state.lastTurnHadNovelResult) {
    state.iterationsSinceProgress = 0;
  } else {
    state.iterationsSinceProgress++;
    const noProgLimit = isWeakOrMedium ? NO_PROGRESS_LIMIT_WEAK : NO_PROGRESS_LIMIT;
    if (state.iterationsSinceProgress >= noProgLimit) {
      logRetry({ kind: "loop-abort", tool: "no-progress", detail: { iterations: state.iterationsSinceProgress, limit: noProgLimit, modelTier: opts?.modelTier, nudgeOnly: opts?.nudgeOnly ?? false } });
      // Reset so the next turn starts clean whether we abort or just nudge.
      state.iterationsSinceProgress = 0;
      if (opts?.nudgeOnly) {
        return emitNudge(`SYSTEM: ${noProgLimit}+ tool calls with no progress (no file/page/API changes). Step back — take a concrete next action or respond to the user now.`);
      }
      return {
        abort: true,
        nudge: `\n\n(No-progress abort: ${noProgLimit}+ iterations of tool calls with zero file mutations. Your work is either done or stuck. End the turn now.)`,
      };
    }
  }
  // Redundant-search detector. Counts by normalized search PATTERN and never
  // resets on progress, so it catches the diffuse re-search the discovery loop
  // above can't see (edits between greps + varied globs keep that one resetting).
  const searchLimit = isWeakOrMedium ? REDUNDANT_SEARCH_LIMIT_WEAK : REDUNDANT_SEARCH_LIMIT;
  let redundant: { term: string; count: number } | null = null;
  for (const tc of toolCalls) {
    const sk = searchKeyOf(tc.name, tc.arguments);
    if (!sk) continue;
    const n = (state.searchKeyCounts.get(sk) || 0) + 1;
    state.searchKeyCounts.set(sk, n);
    if (n >= searchLimit && (n - searchLimit) % REDUNDANT_SEARCH_RENUDGE === 0) {
      redundant = { term: sk.slice(sk.indexOf(":") + 1), count: n };
    }
  }
  if (redundant) {
    logRetry({ kind: "loop-abort", tool: "redundant-search", detail: { term: redundant.term, count: redundant.count, modelTier: opts?.modelTier } });
    return emitNudge(`SYSTEM: you've run the same search (${redundant.term}) ${redundant.count}× this op — re-running it won't change the answer. Stop re-searching: act on the matches you already have (edit the files), or if the search came back clean, move on. Re-run the search only ONCE after you've actually changed files, to confirm.`);
  }

  const stuck = [...state.toolNameCounts.entries()].find(([name, count]) =>
    count >= discoveryLimit && SPIRALABLE_TOOLS.has(name)
  );
  if (stuck) {
    const [toolName, count] = stuck;
    state.toolNameCounts.set(toolName, 0);
    // Pivot-toward-action nudge, not a dead-end "STOP." The model usually
    // has enough context by call N — what it needs is permission to switch
    // tactics, not an instruction to give up. Mention the natural next
    // action so weak models don't flounder picking the next tool.
    const pivotHint = (toolName === "read" || toolName === "glob" || toolName === "grep")
      ? " You have enough context — switch tactic: use write/edit/bash to act on what you've already read, or ask the user a focused question if you're truly stuck."
      : " You have enough context — produce the answer or take the next concrete action.";
    return emitNudge(`SYSTEM: ${toolName} called ${count} times this turn — that's a discovery loop signal.${pivotHint} Do not call ${toolName} again unless you have a specific new file/path/term to look up.`);
  }

  return { abort: false, nudge: null };
}

/**
 * Record a turn's tool results so the next checkToolLoops can read two
 * result-delta signals. Call after dispatch with the same tool calls passed to
 * checkToolLoops.
 *   - Exact-repeat: while the SAME {tool,args} key holds, tell a stuck spin
 *     (same call, same result) from legitimate repetition (changing result).
 *   - Progress (no-progress + discovery): across ANY tools, whether the turn
 *     surfaced a result not seen before this op. A novel result means the agent
 *     learned/changed something; an all-seen turn made no progress.
 */
export function noteToolResults(
  toolCalls: Array<{ name: string; arguments: string }>,
  state: LoopState,
  results: Array<{ content: string }>,
): void {
  // Progress signal — runs every turn, independent of the exact-repeat key.
  let novel = false;
  for (const r of results) {
    const rsig = createHash("sha1").update(r.content).digest("hex");
    if (!state.seenResultSigs.has(rsig)) {
      novel = true;
      state.seenResultSigs.add(rsig);
      if (state.seenResultSigs.size > RESULT_SIG_MEMORY) {
        // Set preserves insertion order — the first key is the oldest.
        state.seenResultSigs.delete(state.seenResultSigs.values().next().value!);
      }
    }
  }
  state.lastTurnHadNovelResult = novel;

  // Exact-repeat signal — only while the repeated {tool,args} key holds.
  const key = toolCalls.map(tc => `${tc.name}:${tc.arguments}`).join("|");
  if (key !== state.lastToolKey) return;
  const sig = createHash("sha1")
    .update(results.map(r => r.content).join(" "))
    .digest("hex");
  if (state.lastResultSig !== null) {
    state.identicalResultRepeats = sig === state.lastResultSig ? state.identicalResultRepeats + 1 : 0;
  }
  state.lastResultSig = sig;
}
