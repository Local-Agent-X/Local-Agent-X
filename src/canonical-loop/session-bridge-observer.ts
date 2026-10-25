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
 *   - state_changed  *      → succeeded  → bg_op_completed (status: completed —
 *                                          or `partial` when the op stopped at
 *                                          an iteration checkpoint, see below)
 *   - state_changed  *      → failed     → bg_op_completed (status: failed)
 *   - state_changed  *      → cancelled  → bg_op_completed (status: cancelled)
 *   - error event                        → bg_op_progress (last error code)
 *   - turn_committed                     → bg_op_progress ("turn N · <tools>")
 *
 * Skipped on purpose:
 *   - Stream chunks (op_stream channel) — that channel carries model output
 *     (`{delta}` tokens, `{replace,text}` rewrites) and nothing else; no
 *     publisher emits a structured `{line}`. Sampling it cannot yield activity
 *     lines, only one sentence-fragment per sample: a forwarder that did this
 *     produced 588 sidebar rows for ~12 real actions against a local model,
 *     which streams a delta per token. Terminal-epilogue notes (build-verify
 *     confirmation, warnings, size notes) ride the same channel as `{delta}`,
 *     but they are part of the worker's final assistant text and surface
 *     intact via bg_op_completed.
 *   - lease_acquired / lease_lost — internal lifecycle, not user-visible.
 */
import { broadcastToSession, getSessionForOp, getTaskForOp, releaseOpFromSession, proactiveSpeakToSession, getSessionPersister } from "../ops/session-bridge.js";
import { isHeadlessSession } from "../chat-ws/broadcast.js";
import { suspendedWorkerStatus, suspensionLine, turnProgressLine } from "./live-workers.js";
import { pushPendingNotification } from "../ops/pending-notifications.js";
import { scheduleIdleNudge } from "../ops/idle-nudge.js";
import { inboxJobResult, runLabel } from "../inbox/producers.js";

import { toSpokenCompletion, redirectAppliedRow, isSidebarSuppressedOpType } from "./session-bridge-extractors.js";
import { recordCorrectionEvent, recordVerificationEvent } from "./session-bridge-verification.js";
import { CORRECTION_OP_TYPE } from "./verification-correct.js";
import { readOp } from "../ops/op-store.js";
import { VERIFICATION_OP_TYPE } from "./verification-spend.js";
import { resolveTerminalOpStatus, type TerminalOpStatus } from "./checkpoint-stop.js";
import { extractFinalAssistantText, resultUrlOfOp } from "./session-bridge-extractors.js";
import type { ServerEvent } from "../types.js";
import type { Op } from "../ops/types.js";
import type { CanonicalEvent } from "./types.js";

import { createLogger } from "../logger.js";
import { createRequire } from "node:module";
import { OP_TYPE } from "../ops/op-types.js";
const require = createRequire(import.meta.url);
const logger = createLogger("canonical-loop.session-bridge-observer");

let warnedOnce = false;

/** Terminal status a card / notification carries. `partial` is a `succeeded`
 *  op that stopped at an iteration checkpoint (checkpoint-stop.ts). */
type TerminalCardStatus = TerminalOpStatus;

/** Spoken line for a checkpoint-stopped op. toSpokenCompletion's lead
 *  ("that background task finished") is the one claim a partial must not make,
 *  and reading the PARTIAL line aloud (op ids, tool names) is noise. */
function toSpokenPartial(task: string): string {
  const what = task ? ` (${task.slice(0, 60)})` : "";
  return `Heads up — that background task stopped at a checkpoint before finishing${what}. Its work is saved, but the task is not done.`;
}

function warnOnce(msg: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  logger.warn(`[canonical-bridge] ${msg} (further warnings suppressed)`);
}

export function recordCanonicalEvent(
  event: CanonicalEvent,
  projection: "all" | "non-browser" = "all",
  sessionId?: string,
): void {
  recordCanonicalEventWithSink(
    event,
    true,
    projection === "all" ? (target, serverEvent) => broadcastToSession(target, serverEvent) : null,
    sessionId,
  );
}

export function collectCanonicalBrowserEvents(
  event: CanonicalEvent,
  sessionId: string,
): { sessionId: string; events: ServerEvent[] } | null {
  const events: ServerEvent[] = [];
  let targetSessionId = "";
  recordCanonicalEventWithSink(event, false, (target, serverEvent) => {
    targetSessionId = target;
    events.push(serverEvent);
  }, sessionId);
  return targetSessionId ? { sessionId: targetSessionId, events } : null;
}

/**
 * Ops the user never sees as workers. Sidebar-suppressed types surface
 * elsewhere or are headless (isSidebarSuppressedOpType); the harness checking
 * and correcting its own work is routed to session-bridge-verification.ts.
 * Either way the session→op binding MUST still be released on terminal
 * state: skipping it leaks every past chat_turn into listOpsForSession
 * forever, which poisons the system prompt with phantom "[PARALLEL CONTEXT]"
 * workers — exactly the leak releaseOpFromSession's doc warns about.
 */
function routedOffTheWorkerSurfaces(event: CanonicalEvent, core: boolean, sessionId: string, op: Op): boolean {
  if (op.type === VERIFICATION_OP_TYPE) { recordVerificationEvent(event, core, sessionId, op); return true; }
  if (op.type === CORRECTION_OP_TYPE) { recordCorrectionEvent(event, core, sessionId, op); return true; }
  if (!op.type || !isSidebarSuppressedOpType(op.type)) return false;
  if (event.type === "state_changed") {
    const to = (event.body as Record<string, unknown> | undefined)?.to;
    if (core && (to === "succeeded" || to === "failed" || to === "cancelled")) releaseOpFromSession(event.opId);
  }
  return true;
}

function recordCanonicalEventWithSink(
  event: CanonicalEvent,
  core: boolean,
  emitBrowser: ((sessionId: string, event: ServerEvent) => void) | null,
  sessionOverride?: string,
): void {
  try {
    const sessionId = sessionOverride ?? getSessionForOp(event.opId);
    if (!sessionId) return; // op wasn't submitted by a chat session — nothing to surface

    const op = readOp(event.opId);
    if (op && routedOffTheWorkerSurfaces(event, core, sessionId, op)) return;

    const task = getTaskForOp(event.opId) ?? op?.task ?? "";
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
          if (emitBrowser) emitBrowser(sessionId, {
            type: "bg_op_queued",
            opId: event.opId,
            task,
            provider: "",
            lane,
            queuePosition: 1,
            // Spawn lineage: carry the spawning op's id through so the agents
            // panel can nest this op under its parent. Absent unless set at
            // submit (ops/delegation.ts delegatingOpId).
            ...(op?.parentOpId ? { parentOpId: op.parentOpId } : {}),
            // Op type: carry the real op type through so the agents panel can
            // pick a per-type icon (app_build/research/self_edit/…) instead of
            // the hardcoded 'coder' glyph. Absent if op unreadable.
            ...(op?.type ? { opType: op.type } : {}),
          } as ServerEvent);
        } else if (to === "running") {
          if (emitBrowser) emitBrowser(sessionId, {
            type: "bg_op_started",
            opId: event.opId,
            task,
            provider: "",
            ...(op?.parentOpId ? { parentOpId: op.parentOpId } : {}),
            ...(op?.type ? { opType: op.type } : {}),
            ...(typeof op?.startedAt === "string" ? { startedAt: op.startedAt } : {}),
          } as ServerEvent);
        } else if (to === "paused") {
          if (emitBrowser) emitBrowser(sessionId, {
            type: "bg_op_progress",
            opId: event.opId,
            status: suspendedWorkerStatus(op),
            line: suspensionLine(op),
            resumable: true,
          });
        } else if (to === "succeeded" || to === "failed" || to === "cancelled") {
          // A `succeeded` op that ended at an iteration checkpoint (dry
          // checkpoints / spend ceiling) is NOT done. The checkpoint's own
          // event is the one record of that (checkpoint-stop.ts), and the
          // PARTIAL line rendered from it is the same one op_wait / op_status
          // show a parent — one formatter. Here it becomes status `partial`:
          // the card, the pending notification, the spoken line and the
          // sidebar all say "unfinished", and no "Open" link is offered for a
          // half-built artifact. Before this, the chat agent was told the op
          // "completed" with the worker's last text as the result.
          const resolved = resolveTerminalOpStatus(event.opId, to);
          const status: TerminalCardStatus = resolved.status;
          // Surface the worker's ACTUAL final message, not a bare "task
          // completed". On completed, the final assistant text IS the result
          // the parent asked for; on failure preserve the durable failure fact
          // rather than replaying stale assistant text from before termination.
          const persistedSummary = resolved.partialSummary
            ?? (status === "completed"
              ? (extractFinalAssistantText(event.opId) || "task completed")
              : (op?.lastFailureReason || status));
          const summary = persistedSummary.slice(0, 400);

          // The "Open" link on the AGENTS sidebar card and the inbox item:
          // one resolver (session-bridge-extractors.ts resultUrlOfOp), only
          // for a completed op.
          const resultUrl = status === "completed" ? resultUrlOfOp(event.opId, op, sessionId) : undefined;

          if (emitBrowser) emitBrowser(sessionId, {
            type: "bg_op_completed",
            opId: event.opId,
            status,
            summary,
            filesChanged: [],
            ...(resultUrl ? { resultUrl } : {}),
            // Headless session (dream-/skill-review-/eval_): bg_op_completed
            // is GLOBAL, and it must still flow (it's what flips the ambient
            // dock card out of "dreaming" + arms its prune) — but the browser
            // reads this stamp to skip the OS toast + fallback FAILED card.
            ...(isHeadlessSession(sessionId) ? { headless: true } : {}),
          });
          if (emitBrowser) emitBrowser(sessionId, {
            type: "worker_done",
            opId: event.opId,
            status,
            summary,
          });

          if (core) pushPendingNotification(sessionId, {
            opId: event.opId,
            status,
            summary: persistedSummary,
            filesChanged: [],
            task: task || "(unknown)",
            completedAt: Date.now(),
          });
          // If the user is in a live voice session, speak the result at the next
          // turn boundary (no-op otherwise — the chat nudge below still fires).
          // The turn machine queues it so it never cuts off an in-flight reply.
          if (core) {
            proactiveSpeakToSession(
              sessionId,
              status === "partial" ? toSpokenPartial(task) : toSpokenCompletion(task, summary, status, op?.type),
            );
            scheduleIdleNudge(sessionId, task);
          }
          // The user's inbox. A scheduled mission is posted by the cron
          // executor, which alone knows its quality-gate verdict; headless
          // harness runs are not the user's jobs.
          if (core && !isHeadlessSession(sessionId) && op?.type !== OP_TYPE.scheduledMission) {
            inboxJobResult({ label: runLabel("Background task", task), outcome: status, summary: persistedSummary, key: `op:${event.opId}`, link: { sessionId, opId: event.opId, ...(resultUrl ? { url: resultUrl } : {}) } });
          }
          if (core) {
            releaseOpFromSession(event.opId);
          }
        }
        return;
      }
      case "error": {
        const code = (b.code as string | undefined) ?? "error";
        const message = (b.message as string | undefined) ?? "";
        if (emitBrowser) emitBrowser(sessionId, {
          type: "bg_op_progress",
          opId: event.opId,
          line: `! ${code}${message ? ": " + message.slice(0, 120) : ""}`,
        } as ServerEvent);
        return;
      }
      case "iteration_checkpoint": {
        const maxTurns = typeof b.maxTurns === "number" ? b.maxTurns : null;
        const continuing = b.continuing === true;
        if (emitBrowser) emitBrowser(sessionId, {
          type: "bg_op_progress",
          opId: event.opId,
          line: continuing
            ? `Checkpoint saved${maxTurns ? ` after ${maxTurns} turns` : ""}; continuing automatically`
            : `Checkpoint saved${maxTurns ? ` after ${maxTurns} turns` : ""}; waiting for continuation`,
        } as ServerEvent);
        return;
      }
      case "turn_committed": {
        const turnIdx = (b.turnIdx as number | undefined) ?? 0;
        // Lead with what the worker actually DID this turn — the tool names,
        // each flagged if it errored — instead of an opaque message count.
        const tools = (b.tools as { tool: string; status: string }[] | undefined) ?? [];
        // Forward the running per-op token total so the AGENTS panel can render
        // a live per-card token bar. checkpoint.ts stamps usage onto every
        // turn_committed (aggregateOpUsage across all persisted op_turns); we
        // relay only the total — additive/optional, absent if unusable.
        const usage = b.usage as { totalTokens?: number } | undefined;
        // The round's model rides along for the panel's Model column.
        const model = (b.context as { model?: unknown } | undefined)?.model;
        if (emitBrowser) emitBrowser(sessionId, {
          type: "bg_op_progress",
          opId: event.opId,
          line: turnProgressLine(turnIdx, tools),
          ...(typeof usage?.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
          ...(typeof model === "string" && model ? { model } : {}),
        } as ServerEvent);
        return;
      }
      case "redirect_applied": {
        // Fires only once the worker has actually CONSUMED the instruction at a
        // turn boundary — not when one was queued. Recording the queued form
        // would put a delivery in the transcript that a finished or dying op
        // never took.
        //
        // The redirect arrives from the worker card or a bridge, so without
        // this it leaves no trace anywhere: the user typed into the sidebar and
        // the chat log shows nothing. (The op_redirect TOOL path is already
        // visible as a tool call in the turn that made it.)
        const turnIdx = (b.turnIdx as number | undefined) ?? 0;
        const text = typeof b.text === "string" ? b.text.trim() : "";
        if (emitBrowser) emitBrowser(sessionId, {
          type: "bg_op_progress",
          opId: event.opId,
          line: text ? `↪ redirect applied · ${text.slice(0, 120)}` : `↪ redirect applied at turn ${turnIdx}`,
        } as ServerEvent);
        // `core` gates the write so the browser-collect projection can't
        // persist a second copy of the same row.
        if (core) {
          const persist = getSessionPersister();
          if (persist) persist(sessionId, redirectAppliedRow(task, text));
        }
        return;
      }
      default:
        // lease_*, message_appended, turn_started, redirect_received,
        // pause/resume — no sidebar surface today. Add cases here if a future
        // event type earns one.
        return;
    }
  } catch (e) {
    warnOnce(`event hook failed: ${(e as Error).message}`);
  }
}

