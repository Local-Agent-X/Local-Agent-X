// Dead-end detector — a tool returned empty/null/zero results N times in a
// row. Instead of grinding the same wrong approach forever (grep 50 files,
// 0 matches, grep 50 more files, 0 matches...), nudge the agent to step
// back and reconsider which tool matches the goal.

export interface DeadEndState { consecutive: number; lastWasEmpty: boolean }

export function createDeadEndState(): DeadEndState {
  return { consecutive: 0, lastWasEmpty: false };
}

/** A tool result that is effectively "no data". */
const EMPTY_RESULT_RE = /^\s*(\(no output\)|\[\]|\{\}|null|none|No results?|0 results?|Nothing found|No matches|No files matched?|No relevant memor|Command failed)/i;

// Progress-style empty, specific to long-running search ops.
const PROGRESS_EMPTY_RE = /Searched\s+\d+\s+files?,\s*0\s+results?/i;

/** Whether a tool result's text says it found nothing. */
export function isEmptyResultText(text: string): boolean {
  return EMPTY_RESULT_RE.test(text);
}

/** Scan a tool result for "empty" signals and update dead-end state. */
export function checkDeadEnd(
  toolName: string,
  toolResult: string,
  state: DeadEndState,
): { nudge: string | null } {
  // Trim to first 400 chars — that's where "no output" / "0 results" land
  const head = (toolResult || "").slice(0, 400);
  const tail = (toolResult || "").slice(-800);
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
