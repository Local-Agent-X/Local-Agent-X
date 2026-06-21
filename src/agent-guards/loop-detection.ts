// Tool-call loop detection. Three signals:
//   1. Exact-repeat: same {tool, args} N times in a row → abort.
//   2. Discovery loop: same READ-ONLY discovery tool (read/grep/glob/
//      web_search/...) called 8+ times → nudge "switch tactic".
//   3. No-progress: N iterations of any tool calls with zero mutations
//      (write/edit/browser/http POST/...) → abort.
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
  // Iterations elapsed since the last MUTATING tool call (write/edit/commit).
  // Build_app worker spun 96 bash calls + 0 file changes for 5 min before kill.
  // No-progress detector: if this exceeds NO_PROGRESS_LIMIT iterations, abort.
  iterationsSinceMutation: number;
  // Set to true on the iteration AFTER a successful `git commit` is observed
  // in a bash tool result. Next iteration the agent gets a nudge to wrap up.
  // The perma-fix mandate keeps agents going past their commit; this caps it.
  postCommitNudgePending: boolean;
}

export function createLoopState(): LoopState {
  return {
    lastToolKey: "",
    sameToolCount: 0,
    lastResultSig: null,
    identicalResultRepeats: 0,
    toolNameCounts: new Map(),
    iterationsSinceMutation: 0,
    postCommitNudgePending: false,
  };
}

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
// Read-only discovery / lookup tools an agent spins on when it can't find
// something. No risk-taxonomy tier models "discovery spin", so this stays a
// curated list — but every member MUST be read-only (a fence test in
// loop-detection.test.ts asserts risk ∈ {safe, network-read}), so a mutating
// tool can never be mistaken for a harmless lookup. Worker-pool status checks
// (op_status / op_wait / agent_status) loop just like the legacy operation_status
// — a chat agent polled op_status 16x in one turn — so they're spiralable too.
//
// Mutation / progress classification (which tools reset the no-progress and
// discovery counters) lives in tool-mutation-check.ts, derived from the risk
// taxonomy. Only this discovery set is curated.
export const SPIRALABLE_TOOLS = new Set([
  "glob", "web_search", "read", "grep",
  "agent_whoami", "agent_team_list", "issue_list", "issue_search",
  "memory_search", "memory_recall", "memory_get",
  "task_list", "operation_status", "operation_list",
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
        state.identicalResultRepeats = 0;
        return { abort: false, nudge: `SYSTEM: ${toolCalls[0]?.name} called with identical arguments and unchanged results ${state.sameToolCount}× — you're looping. Stop repeating it: take a different action, call a different tool, or answer with what you already have.` };
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
  // isProgressTool (local work incl. bash) RESETS the spiralable counts because
  // it proves the agent is doing work, not spinning — the common audit-then-
  // edit-then-verify pattern would otherwise accumulate reads across phases and
  // falsely trip the gate. isMutationTool (narrower — excludes bash) drives the
  // no-progress counter below; both derive from the risk taxonomy in
  // tool-mutation-check.ts.
  let madeProgress = false;
  let madeMutation = false;
  for (const tc of toolCalls) {
    if (isProgressTool(tc.name)) madeProgress = true;
    if (isMutationTool(tc.name)) madeMutation = true;
    state.toolNameCounts.set(tc.name, (state.toolNameCounts.get(tc.name) || 0) + 1);
  }
  if (madeProgress) {
    // Reset only the spiralable counters — progress was made, the prior
    // reads were useful scaffolding, not a spiral. Keep non-spiralable
    // counts intact (they don't gate anything anyway).
    for (const name of SPIRALABLE_TOOLS) state.toolNameCounts.delete(name);
  }
  // No-progress detector: count iterations since the last mutating call.
  // Mutations reset to 0; everything else (bash, read, grep, git status) ticks.
  // When the counter exceeds NO_PROGRESS_LIMIT, abort the turn — the agent is
  // either done (and stalling) or stuck (and spinning).
  if (madeMutation) {
    state.iterationsSinceMutation = 0;
  } else {
    state.iterationsSinceMutation++;
    const noProgLimit = isWeakOrMedium ? NO_PROGRESS_LIMIT_WEAK : NO_PROGRESS_LIMIT;
    if (state.iterationsSinceMutation >= noProgLimit) {
      logRetry({ kind: "loop-abort", tool: "no-progress", detail: { iterations: state.iterationsSinceMutation, limit: noProgLimit, modelTier: opts?.modelTier, nudgeOnly: opts?.nudgeOnly ?? false } });
      // Reset so the next turn starts clean whether we abort or just nudge.
      state.iterationsSinceMutation = 0;
      if (opts?.nudgeOnly) {
        return {
          abort: false,
          nudge: `SYSTEM: ${noProgLimit}+ tool calls with no progress (no file/page/API changes). Step back — take a concrete next action or respond to the user now.`,
        };
      }
      return {
        abort: true,
        nudge: `\n\n(No-progress abort: ${noProgLimit}+ iterations of tool calls with zero file mutations. Your work is either done or stuck. End the turn now.)`,
      };
    }
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
    return {
      abort: false,
      nudge: `SYSTEM: ${toolName} called ${count} times this turn — that's a discovery loop signal.${pivotHint} Do not call ${toolName} again unless you have a specific new file/path/term to look up.`,
    };
  }

  return { abort: false, nudge: null };
}

/**
 * Record the results of a turn's tool calls so the exact-repeat detector can
 * tell a stuck spin (same call, same result) from legitimate repetition (same
 * call, changing result). Call after dispatch with the same tool calls passed
 * to checkToolLoops. Only tracks while the repeated key holds; a key change is
 * reset by checkToolLoops on the next turn.
 */
export function noteToolResults(
  toolCalls: Array<{ name: string; arguments: string }>,
  state: LoopState,
  results: Array<{ content: string }>,
): void {
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
