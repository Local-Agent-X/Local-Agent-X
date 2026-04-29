/**
 * Pending notifications queue — surfaces background-op completions to the
 * chat agent on its next turn so the agent narrates them naturally instead
 * of relying on synthetic "1-line ack" messages.
 *
 * Design rationale (per user feedback "agent should read the signal and
 * report in chat"):
 *
 *   The previous design pushed a fake assistant message ("✓ Worker
 *   finished — opId. See agents panel.") into the chat thread. That had
 *   three problems:
 *     1. Brittle frontend rendering — WS could miss the event, cache
 *        could serve stale chat.js, race conditions could drop it.
 *     2. Synthetic messages feel out of place. Users know they aren't
 *        from the agent and can't ask follow-ups about them naturally.
 *     3. Sidebar + chat duplication = clutter.
 *
 *   The agent-narrates-completion pattern is cleaner:
 *     - Sidebar = live state (working / completed) + full output
 *     - Chat = on the user's NEXT turn, the agent's system prompt
 *       includes a `[BACKGROUND]` section with op completions that
 *       finished while the user was idle. The agent weaves them in
 *       naturally if relevant, or just internalizes them as knowledge.
 *
 * Lifecycle:
 *   - bg_op_completed fires → pushPendingNotification(sessionId, payload)
 *   - User sends next message → drainPendingNotifications(sessionId)
 *     returns + clears the queue, prepare-request injects them as a
 *     system message before the LLM call
 *   - Notifications older than 24h are auto-pruned (handles the case
 *     where user never replies — keeps the queue small)
 */

export interface PendingNotification {
  opId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  filesChanged: string[];
  task: string;             // the original user message that spawned the op
  completedAt: number;      // epoch ms
}

const queues = new Map<string, PendingNotification[]>();
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PER_SESSION = 20;

export function pushPendingNotification(sessionId: string, n: PendingNotification): void {
  if (!sessionId) return;
  let q = queues.get(sessionId);
  if (!q) { q = []; queues.set(sessionId, q); }
  q.push(n);
  // Cap per session — keep the most recent if we hit the limit
  if (q.length > MAX_PER_SESSION) q.splice(0, q.length - MAX_PER_SESSION);
  prune();
}

/**
 * Drain all pending notifications for a session. Returns them and clears
 * the queue (so the same op doesn't get narrated twice across turns).
 */
export function drainPendingNotifications(sessionId: string): PendingNotification[] {
  if (!sessionId) return [];
  const q = queues.get(sessionId);
  if (!q || q.length === 0) return [];
  // Filter out expired ones first
  const now = Date.now();
  const fresh = q.filter(n => now - n.completedAt < TTL_MS);
  queues.delete(sessionId);
  return fresh;
}

/** Format pending notifications as a system-prompt-injectable block. */
export function formatNotificationsForSystemPrompt(notifications: PendingNotification[]): string {
  if (notifications.length === 0) return "";
  const lines = notifications.map(n => {
    const statusEmoji = n.status === "completed" ? "✓" : n.status === "failed" ? "✗" : "⊘";
    const filesLine = n.filesChanged.length > 0
      ? ` (changed ${n.filesChanged.length} file${n.filesChanged.length === 1 ? "" : "s"}: ${n.filesChanged.slice(0, 5).join(", ")})`
      : "";
    return (
      `${statusEmoji} Background op \`${n.opId}\` ${n.status}${filesLine}.\n` +
      `   Original task: "${n.task.slice(0, 200)}${n.task.length > 200 ? "..." : ""}"\n` +
      `   Result: ${n.summary.slice(0, 600)}${n.summary.length > 600 ? "..." : ""}`
    );
  });
  return (
    `\n\n[BACKGROUND COMPLETIONS — ${notifications.length} op${notifications.length === 1 ? "" : "s"} finished while the user was idle]\n` +
    `These are worker-pool ops you delegated earlier (or that auto-delegated on the user's behalf). ` +
    `Mention them naturally in your reply if relevant to the user's current message — e.g. "btw the backtest you asked for finished, added X and Y." ` +
    `If the user's new message is unrelated, just incorporate them as background knowledge without forcing a mention. ` +
    `The user can also see live status in the AGENTS sidebar.\n\n` +
    lines.join("\n\n") +
    `\n\n[end background completions]\n`
  );
}

function prune(): void {
  const now = Date.now();
  for (const [sid, q] of queues) {
    const fresh = q.filter(n => now - n.completedAt < TTL_MS);
    if (fresh.length === 0) queues.delete(sid);
    else if (fresh.length !== q.length) queues.set(sid, fresh);
  }
}
