// Task anchor reminder (Codex anti-drift).
// Long agentic loops cause Codex to lose the original task in context bloat.
// By the time the model has 30 tool results stacked behind it, the user's
// original message is buried — and Codex defaults to asking for clarification
// instead of finishing. Re-anchor every N tool calls.

const ANCHOR_REMINDER_INTERVAL = 5;
const ACTION_TOOLS_FOR_ANCHOR = new Set(["write", "edit", "build_app", "self_edit", "bash"]);

export interface TaskAnchorState {
  totalToolCalls: number;
  lastReminderAt: number;
}

export function createTaskAnchorState(): TaskAnchorState {
  return { totalToolCalls: 0, lastReminderAt: 0 };
}

/**
 * Returns a re-anchor reminder string when total tool calls hits the next
 * ANCHOR_REMINDER_INTERVAL multiple, else null. Caller pushes the returned
 * string as a `user`-role message into the conversation so the next API
 * call sees it before the model decides what to do next.
 */
export function checkTaskAnchor(
  toolCallsThisIteration: number,
  state: TaskAnchorState,
  originalUserMessage: string,
  toolsCalledThisTurn: Set<string>,
): string | null {
  state.totalToolCalls += toolCallsThisIteration;
  if (state.totalToolCalls < state.lastReminderAt + ANCHOR_REMINDER_INTERVAL) return null;
  state.lastReminderAt = state.totalToolCalls;

  const truncated = originalUserMessage.length > 280
    ? originalUserMessage.slice(0, 280) + "..."
    : originalUserMessage;
  const acted = [...ACTION_TOOLS_FOR_ANCHOR].filter(t => toolsCalledThisTurn.has(t));

  return (
    `[Task anchor — ${state.totalToolCalls} tool calls so far] Original request:\n` +
    `> "${truncated}"\n\n` +
    (acted.length > 0
      ? `You've already taken concrete action: ${acted.join(", ")}. If those changes solve the request, FINALIZE NOW with a brief summary of what you changed and stop. Don't ask the user for more context after acting.`
      : `If you have enough context to act, take action now (write/edit/bash). If not, ask ONE focused question and stop. Don't keep grinding through reads.`)
  );
}
