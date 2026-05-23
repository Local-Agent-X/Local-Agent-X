// Post-commit nudge.
//
// Today's failure mode: build_app worker committed at iteration N, then
// continued running for 5 more minutes / 100+ iterations because the
// perma-fix mandate kept it expanding scope ("now wire it into settings UI
// too..."). A successful git commit is a strong signal the user-facing work
// is DONE for this turn — anything more should be a follow-up turn.
//
// Pattern: scan tool results for `bash`-style outputs with git's commit
// success signatures. If found, set state.postCommitNudgePending. The next
// iteration's prompt-layer code reads the flag and injects a wrap-up nudge.
//
// Shares LoopState with loop-detection.ts — the postCommitNudgePending
// flag lives on the per-op loop state so both middlewares can read/write
// without a parallel state record.

import type { LoopState } from "./loop-detection.js";

// Git commit success patterns. Examples:
//   "[main abc1234] commit message"
//   "[feature/x f0e1d2c] msg"
//   " 12 files changed, 345 insertions(+), 67 deletions(-)"
const GIT_COMMIT_OUTPUT_RE = /\[[\w/-]+\s+[a-f0-9]{7,40}\]|\d+\s+files?\s+changed/;

export function checkPostCommit(
  toolResults: Array<{ name: string; result: string }>,
  state: LoopState,
): { nudge: string | null } {
  // First: if a PREVIOUS iteration set the flag, emit the nudge now and clear
  // it. The nudge fires on the iteration AFTER the commit so the agent has a
  // chance to see its commit landed before being told to wrap up.
  let nudge: string | null = null;
  if (state.postCommitNudgePending) {
    state.postCommitNudgePending = false;
    nudge =
      "\n\n(Post-commit nudge: a git commit just landed. Unless the user explicitly asked for additional work in THIS turn, end the turn now with a one-sentence summary of what shipped — further integration is a follow-up task.)";
  }
  // Then: detect a fresh commit in THIS iteration's results and set the flag
  // for the next iteration to see. (Order matters — this must run AFTER the
  // pending-check so a commit detected this iteration doesn't immediately
  // get cleared.)
  for (const r of toolResults) {
    if (r.name !== "bash" && r.name !== "shell") continue;
    if (GIT_COMMIT_OUTPUT_RE.test(r.result)) {
      state.postCommitNudgePending = true;
      break;
    }
  }
  return { nudge };
}
