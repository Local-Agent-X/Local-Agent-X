// Push-based completion signaling for subagents.
//
// Without this, the parent agent has to poll `agent_status` to discover when
// children finish. That burns iterations and models often forget to check.
//
// Bridge rationale (finding OP-1): this file used to own its OWN per-parent
// queue plus drain/peek/format helpers, consumed by the legacy agent loop.
// That consumer was deleted in the legacy-loop removal, leaving the producer
// (handler-completion.ts → enqueueCompletion) writing into a Map that nothing
// ever drained — so a spawned child's completion reached the parent through NO
// channel, and the Map grew unbounded. The canonical owner of "surface an
// async completion to a session on its next turn" is ops/pending-notifications
// (drained by prepare-request/build-system-prompt into the parent's system
// prompt). agent_spawn ops are suppressed from that channel at the sidebar
// observer (session-bridge-observer.ts) to avoid duplicate cards, which also
// dropped the chat-context notice. Rather than fork a second queue, we forward
// sub-agent completions straight into the canonical channel: bounded growth
// (MAX_PER_SESSION + TTL prune) and a real consumer come for free.
//
// The forward is tagged `subAgent: true` so pending-notifications keeps it out
// of the re-delegation dedup history (its `task` is an agent NAME — matching
// user tasks against it false-blocks op_submit_async) and out of the idle
// nudge (internal orchestration must not fire user-facing "op just finished"
// heads-ups). See PendingNotification.subAgent for the full contract.

import { pushPendingNotification } from "../ops/pending-notifications.js";

export interface CompletionNotice {
  agentId: string;
  agentName: string;
  status: "succeeded" | "failed";
  result: string;
  timestamp: number;
}

/**
 * Record that a sub-agent finished, keyed by its parent session, so the parent
 * sees the result on its next turn without polling `agent_status`. Forwards
 * into the canonical pending-notifications channel — see the file header.
 */
export function enqueueCompletion(parentSessionId: string, notice: CompletionNotice): void {
  if (!parentSessionId) return;
  pushPendingNotification(parentSessionId, {
    opId: `agent-${notice.agentId}`,
    status: notice.status === "succeeded" ? "completed" : "failed",
    summary: notice.result,
    filesChanged: [],
    // The sub-agent's name, NOT a user task — the subAgent flag below keeps
    // this out of the task-matching dedup guards and gets it rendered as
    // "Sub-agent `<name>`" (never "Original task") in the system prompt.
    task: notice.agentName || `sub-agent ${notice.agentId}`,
    completedAt: notice.timestamp || Date.now(),
    subAgent: true,
    agentId: notice.agentId,
  });
}
