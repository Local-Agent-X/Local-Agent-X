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
// Separate from `queues`: this map tracks recently-completed ops as a guard
// against re-delegation. `queues` gets DRAINED when the user sends a message
// (so the same op isn't narrated twice), but the guard needs to remember
// completions across drains — otherwise the "yo"-after-drain pattern slips
// through and the agent re-spawns a just-finished task.
const completionHistory = new Map<string, PendingNotification[]>();
const TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_TTL_MS = 30 * 60 * 1000;
const MAX_PER_SESSION = 20;
const MAX_HISTORY_PER_SESSION = 30;

export function pushPendingNotification(sessionId: string, n: PendingNotification): void {
  if (!sessionId) return;
  let q = queues.get(sessionId);
  if (!q) { q = []; queues.set(sessionId, q); }
  q.push(n);
  if (q.length > MAX_PER_SESSION) q.splice(0, q.length - MAX_PER_SESSION);

  let h = completionHistory.get(sessionId);
  if (!h) { h = []; completionHistory.set(sessionId, h); }
  h.push(n);
  if (h.length > MAX_HISTORY_PER_SESSION) h.splice(0, h.length - MAX_HISTORY_PER_SESSION);

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

/**
 * Peek (without draining) — used by op_submit_async to detect when an
 * agent is about to re-delegate a task that already completed in the
 * same session. Without this guard, "yo" follow-ups can trigger redundant
 * worker spawns because the agent sees the pending notification and
 * misreads it as "user wants me to do this again."
 *
 * Recency window: 10 min. After that we assume genuine re-runs are intended.
 */
const RECENT_COMPLETION_WINDOW_MS = 10 * 60 * 1000;

export function findRecentCompletionMatching(sessionId: string, candidateTask: string): PendingNotification | null {
  if (!sessionId || !candidateTask) return null;
  const h = completionHistory.get(sessionId);
  if (!h || h.length === 0) return null;
  const now = Date.now();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(candidateTask).slice(0, 120);
  for (const n of h) {
    if (now - n.completedAt > RECENT_COMPLETION_WINDOW_MS) continue;
    const prior = norm(n.task).slice(0, 120);
    if (prior.length < 8 || target.length < 8) continue;
    if (prior.includes(target) || target.includes(prior)) return n;
  }
  return null;
}

export function findAnyRecentCompletion(sessionId: string): PendingNotification | null {
  if (!sessionId) return null;
  const h = completionHistory.get(sessionId);
  if (!h || h.length === 0) return null;
  const now = Date.now();
  for (let i = h.length - 1; i >= 0; i--) {
    if (now - h[i].completedAt <= RECENT_COMPLETION_WINDOW_MS) return h[i];
  }
  return null;
}

// Summary preview length passed to the agent. The agent gets just enough to
// classify the result and offer the right next action ("want a summary?",
// "want a diff?"). The full summary is held in the op artifact and pulled on
// demand via op_status. Keeping this small is the single strongest constraint
// against the "dump the whole report unprompted" failure mode.
const SUMMARY_PREVIEW_CHARS = 180;

/** Format pending notifications as a system-prompt-injectable block. */
export function formatNotificationsForSystemPrompt(notifications: PendingNotification[]): string {
  if (notifications.length === 0) return "";
  const lines = notifications.map(n => {
    const statusEmoji = n.status === "completed" ? "✓" : n.status === "failed" ? "✗" : "⊘";
    const filesLine = n.filesChanged.length > 0
      ? ` (changed ${n.filesChanged.length} file${n.filesChanged.length === 1 ? "" : "s"}: ${n.filesChanged.slice(0, 5).join(", ")})`
      : "";
    const preview = n.summary.slice(0, SUMMARY_PREVIEW_CHARS);
    const truncatedNote = n.summary.length > SUMMARY_PREVIEW_CHARS
      ? ` …[full summary withheld — ${n.summary.length} chars total; available via op_status(op_id="${n.opId}") if user asks]`
      : "";
    return (
      `${statusEmoji} Background op \`${n.opId}\` ${n.status}${filesLine}.\n` +
      `   Original task: "${n.task.slice(0, 160)}${n.task.length > 160 ? "..." : ""}"\n` +
      `   Preview: ${preview}${truncatedNote}`
    );
  });
  return (
    `\n\n[BACKGROUND COMPLETIONS — ${notifications.length} op${notifications.length === 1 ? "" : "s"} finished while the user was idle]\n` +
    `Worker ops you (or auto-delegate) submitted earlier have finished. The work IS DONE.\n\n` +
    `**HOW TO SURFACE — STRICT FORMAT (this is a hard contract, not a suggestion):**\n` +
    `- **One short sentence acknowledging it's done** + **one short sentence offering the next action**. That is the entire mention. Two sentences max.\n` +
    `- **NEVER paste the preview text into your reply.** Never paste the summary, never paraphrase a paragraph of it, never list the files changed unless the user asks. The preview below is for YOUR understanding only — it tells you what the work was so you can offer the right next action.\n` +
    `- **Pick the next-action offer based on output type**: text/research → "want me to summarize the key findings?"; code/edits → "want a diff?"; long doc → "want me to drop it as a PDF?"; small fix → just "anything else?".\n` +
    `- **If the user is mid-conversation about something else**: append the two-sentence ack at the END of your normal reply. Example: "...and that's how trade winds form. Quick heads up — the research op finished. Want me to summarize the findings?" The ack is a tail, not a takeover.\n` +
    `- **If the user's message is itself about the op** ("did it work?", "how'd it go?"): you can give a slightly longer acknowledgment but still no full paste — paraphrase in 1-2 sentences and offer the full output.\n` +
    `- **Failed status**: same brief format. "The X op hit an error — want me to look at what went wrong?" Don't dump the error stack.\n\n` +
    `**Other rules:**\n` +
    `- **DO NOT call op_submit_async / agent_spawn / build_app for any task that's already in the list below.** The work is DONE. If your impulse is to "kick it off," resist — surface the existing result instead. The op-tools will auto-block obvious duplicates, but don't even try.\n` +
    `- **Do NOT re-verify the work.** No reading files, grepping, browsing to "check." The worker already executed.\n` +
    `- **Do NOT redo the work yourself.** If the result looks off, ask the user before re-running.\n` +
    `- **Short user messages ("yo", "hey", "ok", "thx") are NOT requests to re-run work.** They're just the user reconnecting. Acknowledge briefly + offer to surface the completed result.\n` +
    `- **"failed" can be a misclassification** — if the preview describes concrete changes, trust the work happened; mention "failed" only if the preview shows nothing landed.\n\n` +
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
  for (const [sid, h] of completionHistory) {
    const fresh = h.filter(n => now - n.completedAt < HISTORY_TTL_MS);
    if (fresh.length === 0) completionHistory.delete(sid);
    else if (fresh.length !== h.length) completionHistory.set(sid, fresh);
  }
}
