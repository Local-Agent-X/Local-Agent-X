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

import { logRetry } from "../retry-telemetry.js";

export interface LoopState {
  lastToolKey: string;
  sameToolCount: number;
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
// A mutation is a tool that committed *real-world* work — disk write, page
// click, HTTP POST, message sent. Note `bash` is NOT here despite being in
// PROGRESS_TOOLS for the spiralable-reset logic — bash can spin without
// producing changes (git status loops, grep loops). The other read-only
// tools (`read`, `grep`, `glob`, `web_search`, `snapshot`-style ops) are
// also excluded — those genuinely don't change anything.
//
// Live failure (2026-05-13, the customer PO-entry workflow on codex): agent drove
// the browser through 6 form-fill / click iterations without writing a
// single file. Each `browser` call was real progress (PO number set,
// vendor field populated, line items being added) but the no-progress
// guard saw "zero file mutations" and aborted the turn with
// "No-progress abort: 6+ iterations of tool calls with zero file
// mutations." That's a false positive — browser-driven tasks don't
// mutate files, they mutate external systems.
//
// Fix shape: anything that produces a side effect outside the agent's
// process counts. `browser` covers UI automation (clicks, fills,
// navigations). `http_request` covers API calls. The communication tools
// cover messaging. Membership here means "this tool just did something
// observable; the counter resets."
export const MUTATION_TOOLS = new Set([
  // File changes
  "write", "edit", "self_edit", "build_app",
  "mcp_filesystem_write_file", "mcp_filesystem_edit_file",
  // Browser-driven UI work (every browser action is potentially side-
  // effecting; reading args to filter would over-fit, just count all)
  "browser",
  // HTTP — non-GET methods are committing per committing-tool-check.ts.
  // We don't have args here to filter by method; counting all http_request
  // calls is the right tradeoff (GETs are also progress in the sense that
  // they ARE happening — model isn't spinning if it's hitting endpoints).
  "http_request",
  // Communication / external sends
  "email_send", "whatsapp_send", "telegram_send", "sms_send",
  // Calendar / contacts mutations
  "calendar_create", "calendar_update", "calendar_delete",
  "contacts_create", "contacts_update", "contacts_delete",
  // Vault / secrets writes
  "secret_save", "secret_delete",
  "browser_capture_to_secret", "browser_fill_from_secret",
  // Sidebar / UI state
  "sidebar_pin", "sidebar_unpin",
  // Memory writes
  "memory_save", "memory_update_profile",
  // Cron / scheduling mutations
  "cron_create", "cron_delete", "cron_update",
  // Delegation (spawning a worker IS the action)
  "agent_spawn", "delegate", "op_submit", "op_submit_async",
  "operation_start",
]);

/**
 * Check for exact-repeat loops and discovery loops. Weak/medium models
 * loop harder and faster than strong ones, so we halve the thresholds:
 * exact-repeat fires at 2x instead of 3x, discovery at 4 instead of 8.
 * Returns a nudge message if a loop is detected, or null.
 */
export function checkToolLoops(
  toolCalls: Array<{ name: string; arguments: string }>,
  state: LoopState,
  opts?: { modelTier?: "weak" | "medium" | "strong" },
): { abort: boolean; nudge: string | null } {
  const isWeakOrMedium = opts?.modelTier === "weak" || opts?.modelTier === "medium";
  const repeatLimit = isWeakOrMedium ? 2 : 3;
  const discoveryLimit = isWeakOrMedium ? DISCOVERY_LOOP_THRESHOLD_WEAK : DISCOVERY_LOOP_THRESHOLD;

  // Exact-repeat detection
  const key = toolCalls.map(tc => `${tc.name}:${tc.arguments}`).join("|");
  if (key === state.lastToolKey) {
    state.sameToolCount++;
    if (state.sameToolCount >= repeatLimit) {
      logRetry({ kind: "loop-abort", tool: toolCalls[0]?.name, detail: { repeatLimit, modelTier: opts?.modelTier } });
      return { abort: true, nudge: "\n\n(Detected repeated tool calls — stopping loop)" };
    }
  } else {
    state.sameToolCount = 1;
    state.lastToolKey = key;
  }

  // Discovery-style loop detection: same READ-ONLY discovery tool called 8+
  // times suggests the agent is spinning trying to find something. Action
  // tools (browser, http_request) are intentionally NOT in this list — they
  // do progressive work and 8+ sequential calls is normal multi-step
  // automation, not a spiral. Exact-repeat detection above (3x same call
  // with identical args) catches true browser loops.
  //
  // Progress tools (write/edit/bash/build_app/self_edit) RESET the spiralable
  // counts because they prove the agent is doing work, not spinning. The
  // common audit-then-edit-then-verify-then-edit pattern would otherwise
  // accumulate reads across all phases and falsely trip the gate during
  // legitimate multi-step work on a large file.
  const PROGRESS_TOOLS = new Set([
    "write", "edit", "bash", "build_app", "self_edit",
    "task_create", "task_update",
    "op_submit", "op_submit_async",
    "memory_save", "memory_update_profile",
  ]);
  const SPIRALABLE_TOOLS = new Set([
    "glob", "web_search", "read", "grep",
    "agent_whoami", "agent_team_list", "issue_list", "issue_search",
    "memory_search", "memory_recall", "memory_get",
    "task_list", "operation_status", "operation_list",
    // Worker-pool status checks loop just like the legacy operation_status —
    // chat agent kept polling op_status 16x in one turn waiting for a long
    // op to finish. Treat as spiralable so the discovery-limit guard fires.
    "op_status", "op_wait", "agent_status", "agent_output",
  ]);
  let madeProgress = false;
  let madeMutation = false;
  for (const tc of toolCalls) {
    if (PROGRESS_TOOLS.has(tc.name)) madeProgress = true;
    if (MUTATION_TOOLS.has(tc.name)) madeMutation = true;
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
      logRetry({ kind: "loop-abort", tool: "no-progress", detail: { iterations: state.iterationsSinceMutation, limit: noProgLimit, modelTier: opts?.modelTier } });
      // Reset so the next turn starts clean if the parent loop ignores the abort.
      state.iterationsSinceMutation = 0;
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
