// Dead-end detector — a tool returned empty/null/zero results N times in a
// row. Instead of grinding the same wrong approach forever (grep 50 files,
// 0 matches, grep 50 more files, 0 matches...), nudge the agent to step
// back and reconsider which tool matches the goal.

import { isEmptyResultText } from "../errors/index.js";

export interface DeadEndState { consecutive: number; lastWasEmpty: boolean }

export function createDeadEndState(): DeadEndState {
  return { consecutive: 0, lastWasEmpty: false };
}

// "0 results" patterns owned by src/errors/classifier.ts. Progress-style
// empty stays here because it's specific to long-running search ops, not
// a general error pattern.
const PROGRESS_EMPTY_RE = /Searched\s+\d+\s+files?,\s*0\s+results?/i;

/** Scan a tool result for "empty" signals and update dead-end state. */
export function checkDeadEnd(
  toolName: string,
  toolResult: string,
  state: DeadEndState,
): { nudge: string | null } {
  // Trim to first 400 chars — that's where "no output" / "0 results" land
  const head = (toolResult || "").slice(0, 400);
  const tail = (toolResult || "").slice(-800);
  // EMPTY_RESULT_RE moved to src/errors/classifier.ts (single owner).
  // Use the dedicated isEmptyResultText helper.
  const isEmpty =
    head.trim().length === 0 ||
    isEmptyResultText(head) ||
    PROGRESS_EMPTY_RE.test(head) || PROGRESS_EMPTY_RE.test(tail);
  if (isEmpty) {
    state.consecutive++;
    state.lastWasEmpty = true;
  } else {
    state.consecutive = 0;
    state.lastWasEmpty = false;
  }

  // After 3 empty results in a row, force a rethink
  if (state.consecutive >= 3) {
    state.consecutive = 0; // reset so we don't spam the same nudge
    return {
      nudge:
        `SYSTEM: Your last 3 tool calls returned no results. You're going down the wrong path. ` +
        `STOP, reconsider the goal, and pick a DIFFERENT tool or approach. ` +
        `If you were searching files, maybe you need an API call. ` +
        `If you were using ${toolName}, try tool_search to discover alternatives. ` +
        `Do NOT repeat the same approach.`,
    };
  }
  return { nudge: null };
}
