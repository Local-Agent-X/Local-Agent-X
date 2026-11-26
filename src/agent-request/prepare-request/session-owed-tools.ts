/**
 * The tools a session has because something is waiting on it to call them.
 *
 * A message that says "answer with tool X" is only an honest request when the
 * turn it lands in has X. The build engine asks the chat that leads a build to
 * answer each decision with `build_decide`, and a code session's tools are its
 * kit plus what the model loaded through tool_search earlier in the session
 * (tool-selection.ts). That union is kept in memory, so it was gone after
 * every restart: the lead was asked for `build_decide`, could not call it, and
 * polled `build_plan_status` until the loop guard ended the turn, once per
 * decision, for a whole build (label-check-grok, 2026-11-26: six unanswered
 * decisions and 99 status calls before the restart, four and 56 after).
 *
 * So the asker says so here for as long as it waits, and every tool set a
 * turn can get includes what the session is owed, like the device tools of a
 * phone app's session (device-tools.ts).
 */

const owed = new Map<string, Map<string, number>>();

/**
 * `sessionId` is being asked to call `toolName`: it is in the session's tool
 * set until the returned function is called. Counted, so two requests for one
 * tool release it only when both are done.
 */
export function oweSessionTool(sessionId: string, toolName: string): () => void {
  const tools = owed.get(sessionId) ?? new Map<string, number>();
  owed.set(sessionId, tools);
  tools.set(toolName, (tools.get(toolName) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (tools.get(toolName) ?? 1) - 1;
    if (left > 0) tools.set(toolName, left);
    else tools.delete(toolName);
    if (tools.size === 0 && owed.get(sessionId) === tools) owed.delete(sessionId);
  };
}

/** The tools `sessionId` is waiting to be called with; none when nothing waits. */
export function owedToolNamesFor(sessionId: string): string[] {
  return [...(owed.get(sessionId)?.keys() ?? [])];
}
