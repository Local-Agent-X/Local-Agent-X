/**
 * Surface canonical-loop ops in the AGENTS sidebar by translating
 * canonical events into the same `bg_op_*` chat-WS events that the
 * legacy worker pool emits via ops/session-bridge.ts.
 *
 * Hooked into the canonical event seam (see event-emitter.ts) — this
 * module is a passive observer. Never throws, never blocks, never
 * modifies loop behavior. If translation fails, the metric/event is
 * dropped and a single warning is logged.
 *
 * Mapping:
 *   - state_changed  null   → queued     → bg_op_queued
 *   - state_changed  queued → running    → bg_op_started
 *   - state_changed  *      → succeeded  → bg_op_completed (status: completed)
 *   - state_changed  *      → failed     → bg_op_completed (status: failed)
 *   - state_changed  *      → cancelled  → bg_op_completed (status: cancelled)
 *   - error event                        → bg_op_progress (last error code)
 *   - turn_committed                     → bg_op_progress ("turn N committed")
 *
 * Skipped on purpose:
 *   - Stream chunks (op_stream channel) — too high frequency for the
 *     sidebar; would flood updateAgentFeed at token rates.
 *   - lease_acquired / lease_lost — internal lifecycle, not user-visible.
 */
import { broadcastToSession, getSessionForOp, getTaskForOp, releaseOpFromSession } from "../ops/session-bridge.js";
import { pushPendingNotification } from "../ops/pending-notifications.js";
import { scheduleIdleNudge } from "../ops/idle-nudge.js";
import { readOp } from "../ops/op-store.js";
import type { ServerEvent } from "../types.js";
import type { CanonicalEvent } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.session-bridge-observer");

let warnedOnce = false;

function warnOnce(msg: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  logger.warn(`[canonical-bridge] ${msg} (further warnings suppressed)`);
}

export function recordCanonicalEvent(event: CanonicalEvent): void {
  try {
    const sessionId = getSessionForOp(event.opId);
    if (!sessionId) return; // op wasn't submitted by a chat session — nothing to surface

    // Suppress AGENTS-sidebar cards for `chat_turn` ops. The canonical
    // chat-bridge submits one of these per chat reply for path unification;
    // they are NOT worker delegations and shouldn't appear as worker cards.
    // The chat reply itself surfaces through the WS stream channel directly.
    //
    // Same for `agent_spawn` ops: the spawned agent's lifecycle (handled
    // by handler-events) emits its own agent-specific card keyed on the
    // run id (e.g. field-agent-1-...). Surfacing the canonical-loop op
    // here too would render TWO cards per spawn (Worker: <task> + the
    // named specialist), which is what users see in the sidebar.
    //
    // Same for `voice_turn` ops: each voice utterance submits one of these
    // through voiceTurnRunner. They are conversation turns, not background
    // delegations — the spoken reply already surfaces through the voice WS
    // (assistant_delta + TTS). Without this filter, every voice utterance
    // stacks a "Worker: op_voice_..." card in the AGENTS sidebar — exactly
    // the original triage symptom "Voice spawns an agent per sentence".
    const op = readOp(event.opId);
    if (op?.type === "chat_turn" || op?.type === "agent_spawn" || op?.type === "voice_turn") return;

    const task = getTaskForOp(event.opId) ?? "";
    const b = (event.body ?? {}) as Record<string, unknown>;

    switch (event.type) {
      case "state_changed": {
        const from = (b.from ?? null) as string | null;
        const to = b.to as string | undefined;
        if (!to) return;
        if (from === null && to === "queued") {
          // Op submitted into canonical scheduler. Lane caps mean queueing
          // is real but typically brief.
          const lane = (op?.lane as string | undefined) ?? "interactive";
          broadcastToSession(sessionId, {
            type: "bg_op_queued",
            opId: event.opId,
            task,
            provider: "",
            lane,
            queuePosition: 1,
          } as ServerEvent);
        } else if (to === "running") {
          broadcastToSession(sessionId, {
            type: "bg_op_started",
            opId: event.opId,
            task,
            provider: "",
          } as ServerEvent);
        } else if (to === "succeeded" || to === "failed" || to === "cancelled") {
          const status: "completed" | "failed" | "cancelled" = to === "succeeded" ? "completed" : to;
          const persistedSummary = op?.lastFailureReason ?? (status === "completed" ? "task completed" : status);
          const summary = persistedSummary.slice(0, 400);

          broadcastToSession(sessionId, {
            type: "bg_op_completed",
            opId: event.opId,
            status,
            summary,
            filesChanged: [],
          } as ServerEvent);
          broadcastToSession(sessionId, {
            type: "worker_done",
            opId: event.opId,
            status,
            summary,
          } as ServerEvent);

          pushPendingNotification(sessionId, {
            opId: event.opId,
            status,
            summary: persistedSummary,
            filesChanged: [],
            task: task || "(unknown)",
            completedAt: Date.now(),
          });
          scheduleIdleNudge(sessionId, task);
          releaseOpFromSession(event.opId);
        }
        return;
      }
      case "error": {
        const code = (b.code as string | undefined) ?? "error";
        const message = (b.message as string | undefined) ?? "";
        broadcastToSession(sessionId, {
          type: "bg_op_progress",
          opId: event.opId,
          line: `! ${code}${message ? ": " + message.slice(0, 120) : ""}`,
        } as ServerEvent);
        return;
      }
      case "turn_committed": {
        const turnIdx = (b.turnIdx as number | undefined) ?? 0;
        const messageCount = (b.messageCount as number | undefined) ?? 0;
        broadcastToSession(sessionId, {
          type: "bg_op_progress",
          opId: event.opId,
          line: `✓ turn ${turnIdx} committed (${messageCount} msg)`,
        } as ServerEvent);
        return;
      }
      default:
        // lease_*, message_appended, turn_started, redirect_*, pause/resume —
        // no sidebar surface today. Add cases here if a future event type
        // earns one.
        return;
    }
  } catch (e) {
    warnOnce(`event hook failed: ${(e as Error).message}`);
  }
}
