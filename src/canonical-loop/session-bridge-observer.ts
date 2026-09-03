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
import { isDispatchFailure } from "./types.js";
import { pushPendingNotification } from "../ops/pending-notifications.js";
import { scheduleIdleNudge } from "../ops/idle-nudge.js";

import { toSpokenCompletion, redirectAppliedRow } from "./session-bridge-extractors.js";
import { readOp } from "../ops/op-store.js";
import { VERIFICATION_OP_TYPE } from "./verification-spend.js";
import { extractAppReadyUrl, extractArtifactUrl, extractFinalAssistantText } from "./session-bridge-extractors.js";
import type { ServerEvent } from "../types.js";
import type { CanonicalEvent } from "./types.js";

import { createLogger } from "../logger.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const logger = createLogger("canonical-loop.session-bridge-observer");

let warnedOnce = false;

function warnOnce(msg: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  logger.warn(`[canonical-bridge] ${msg} (further warnings suppressed)`);
}

/**
 * Op types that never surface in the AGENTS sidebar, never queue a pending
 * notification and never schedule an idle nudge. They STILL take the terminal
 * release branch in recordCanonicalEventWithSink (see the leak note there).
 *
 *   chat_turn     the chat reply itself (WS stream channel), not a worker card
 *   agent_spawn   handler-events emits the named-agent card; this doubled it
 *   voice_turn    one per utterance; the reply is TTS audio, not a card
 *   skill_review  background-jobs/skill-review.ts — headless post-turn audit,
 *                 bound by trackOpForSession to its synthetic fork session
 *                 (skill-review-<ts>-<seq>). bg_op_* is a GLOBAL chat-WS
 *                 family, so every client saw "Worker: <untrusted-recalled-
 *                 data …> FAILED" cards plus a "hit a snag" idle nudge.
 *
 * NOT here on purpose: memory_consolidation — its bg_op_queued/started (with
 * opType) are the only feed for the ambient "dreaming" dock
 * (public/js/chat-agent-feeds-ambient.js). Suppressing it kills that dock.
 */
const SIDEBAR_SUPPRESSED_OP_TYPES: ReadonlySet<string> = new Set([
  "chat_turn", "agent_spawn", "voice_turn", "skill_review",
]);

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
    if (op?.type && SIDEBAR_SUPPRESSED_OP_TYPES.has(op.type)) {
      // Suppressed from the AGENTS sidebar (these surface elsewhere, or are
      // headless — see SIDEBAR_SUPPRESSED_OP_TYPES), but the session→op
      // binding MUST still be released on terminal state. Skipping it leaks
      // every past chat_turn into listOpsForSession forever, which poisons the
      // system prompt with phantom "[PARALLEL CONTEXT]" workers. Exactly the
      // leak releaseOpFromSession's doc warns about.
      if (event.type === "state_changed") {
        const to = (event.body as Record<string, unknown> | undefined)?.to;
        if (core && (to === "succeeded" || to === "failed" || to === "cancelled")) {
          releaseOpFromSession(event.opId);
        }
      }
      return;
    }

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
            // submit (ops/tools/shared.ts resolveParentOpId).
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
          } as ServerEvent);
        } else if (to === "paused") {
          const suspension = op?.canonical?.suspension;
          const status = suspension?.reason === "blocked"
            ? "blocked"
            : suspension?.reason === "stalled"
              ? "stalled"
              : "paused";
          if (emitBrowser) emitBrowser(sessionId, {
            type: "bg_op_progress",
            opId: event.opId,
            status,
            line: suspension?.detail || "Operation paused",
            resumable: true,
          } as ServerEvent);
        } else if (to === "succeeded" || to === "failed" || to === "cancelled") {
          const status: "completed" | "failed" | "cancelled" = to === "succeeded" ? "completed" : to;
          // Failed/cancelled verification pass = harness noise (the class the
          // skill-review quieting purged): AGENTS card + logs only — no toast,
          // notification, spoken line, or nudge. A verdict keeps full surfacing.
          const quietVerifyFailure = op?.type === VERIFICATION_OP_TYPE && status !== "completed";
          // Surface the worker's ACTUAL final message, not a bare "task
          // completed". On completed, the final assistant text IS the result
          // the parent asked for; on failure preserve the durable failure fact
          // rather than replaying stale assistant text from before termination.
          const finalText = extractFinalAssistantText(event.opId);
          const persistedSummary = status === "completed"
            ? (finalText || "task completed")
            : (op?.lastFailureReason || status);
          const summary = persistedSummary.slice(0, 400);

          // Surface an "Open" link on the AGENTS sidebar card. Resolution
          // order, most specific to most generic — so a tool that emits
          // an explicit marker wins over a generic "Created <path>" scan.
          //
          //   1. app_build's "APP_READY: <url>" final-assistant marker.
          //   2. scheduled_mission → /api/cron/<jobId>/reports/latest
          //      (rendered HTML page; resolver picks newest .md by mtime).
          //   3. Generic artifact scan — any tool_result with a
          //      "Created /workspace/foo.docx" / "Wrote N bytes to ..."
          //      / "App built ... Open: ..." line. Covers
          //      document / presentation / pdf /
          //      spreadsheet / write / create_page / etc.
          //
          // The generic scan is gated to `status === "completed"` so a
          // failed run doesn't surface a half-written artifact as a link.
          let resultUrl: string | undefined;
          if (status === "completed") {
            if (op?.type === "app_build") {
              // Prefer the op's known appUrl — deterministic, provider-agnostic.
              // Falls back to the APP_READY marker only for legacy ops that
              // predate the appUrl field.
              resultUrl = op.appUrl || extractAppReadyUrl(event.opId);
            } else if (op?.type === "scheduled_mission") {
              const sess = sessionId || "";
              const cronMatch = sess.match(/^cron-(.+)-\d+$/);
              if (cronMatch && cronMatch[1]) {
                resultUrl = `/api/cron/${cronMatch[1]}/reports/latest`;
              }
            }
            // Fallback: generic artifact extraction for any op type that
            // didn't get a specific URL above. Catches the long tail —
            // doc/ppt/pdf/sheet/page workers all land here. getRuntimeConfig
            // is synchronous; using require() (not import) lets us stay
            // inside the non-async observer callback the canonical-loop
            // invokes us from.
            if (!resultUrl) {
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const cfg = (require("../config.js") as typeof import("../config.js")).getRuntimeConfig();
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const workspaceDir = (require("node:path") as typeof import("node:path")).resolve(cfg.workspace);
                resultUrl = extractArtifactUrl(event.opId, workspaceDir);
              } catch { /* config not ready / workspace unresolvable — skip */ }
            }
          }

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
            // A failed verification pass borrows the stamp (card, no toast).
            ...(isHeadlessSession(sessionId) || quietVerifyFailure ? { headless: true } : {}),
          } as ServerEvent);
          if (emitBrowser) emitBrowser(sessionId, {
            type: "worker_done",
            opId: event.opId,
            status,
            summary,
          } as ServerEvent);

          if (core && !quietVerifyFailure) pushPendingNotification(sessionId, {
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
          if (core && !quietVerifyFailure) {
            proactiveSpeakToSession(sessionId, toSpokenCompletion(task, summary, status, op?.type));
            scheduleIdleNudge(sessionId, task);
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
        const tools = (b.tools as { tool: string; status: string }[] | undefined) ?? [];
        // Lead with what the worker actually DID this turn — the tool names,
        // each flagged if it errored — instead of an opaque message count.
        // Bare "turn N" with no tools means a pure text/reasoning turn.
        const summary = tools.length > 0
          ? tools.map((t) => (isDispatchFailure(t.status) ? `${t.tool} ✗` : t.tool)).join(", ")
          : "thinking";
        // Forward the running per-op token total so the AGENTS panel can render
        // a live per-card token bar. checkpoint.ts stamps usage onto every
        // turn_committed (aggregateOpUsage across all persisted op_turns); we
        // relay only the total — additive/optional, absent if unusable.
        const usage = b.usage as { totalTokens?: number } | undefined;
        if (emitBrowser) emitBrowser(sessionId, {
          type: "bg_op_progress",
          opId: event.opId,
          line: `✓ turn ${turnIdx} · ${summary}`,
          ...(typeof usage?.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
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
