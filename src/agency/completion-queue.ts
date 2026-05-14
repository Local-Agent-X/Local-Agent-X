// Push-based completion signaling for subagents.
//
// Without this, the parent agent has to poll `agent_status` to discover when
// children finish. That burns iterations and models often forget to check.
//
// Pattern: when a subagent completes (or errors), push a notice onto a queue
// keyed by the parent session ID. The parent's agent loop drains the queue
// at the start of each iteration and injects a synthetic user message —
// so the parent sees completions inline, even without calling agent_status.

export interface CompletionNotice {
  agentId: string;
  agentName: string;
  status: "succeeded" | "failed";
  result: string;
  timestamp: number;
}

// parentSessionId → queued notices
const queues = new Map<string, CompletionNotice[]>();

export function enqueueCompletion(parentSessionId: string, notice: CompletionNotice): void {
  if (!parentSessionId) return;
  let q = queues.get(parentSessionId);
  if (!q) { q = []; queues.set(parentSessionId, q); }
  q.push(notice);
}

/** Pop and return all pending notices for this parent session. Clears the queue. */
export function drainCompletions(parentSessionId: string): CompletionNotice[] {
  if (!parentSessionId) return [];
  const q = queues.get(parentSessionId);
  if (!q || q.length === 0) return [];
  queues.delete(parentSessionId);
  return q;
}

export function peekCompletions(parentSessionId: string): number {
  return queues.get(parentSessionId)?.length ?? 0;
}

/**
 * Build a single synthetic user message summarizing all drained completions.
 * Truncates each result to keep the injection from blowing up context.
 */
export function formatCompletionMessage(notices: CompletionNotice[]): string {
  if (notices.length === 0) return "";
  const lines: string[] = [`[SUBAGENT UPDATE — ${notices.length} agent(s) completed while you were working]`];
  for (const n of notices) {
    const preview = n.result.length > 2000 ? `${n.result.slice(0, 2000)}\n... [truncated, use agent_output for full result]` : n.result;
    lines.push(`\n— ${n.agentName} (${n.agentId}) → ${n.status}:\n${preview}`);
  }
  lines.push(`\n[End of subagent updates. Continue with your task using these results as appropriate.]`);
  return lines.join("\n");
}

/** Clear all queues — used on session cleanup. */
export function clearCompletions(parentSessionId: string): void {
  queues.delete(parentSessionId);
}
