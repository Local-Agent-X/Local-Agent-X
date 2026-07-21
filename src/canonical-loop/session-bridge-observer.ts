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
 *   - Stream chunks (op_stream channel) — too high frequency for the
 *     sidebar; would flood updateAgentFeed at token rates.
 *   - lease_acquired / lease_lost — internal lifecycle, not user-visible.
 */
import { broadcastToSession, getSessionForOp, getTaskForOp, releaseOpFromSession, proactiveSpeakToSession } from "../ops/session-bridge.js";
import { isDispatchFailure } from "./types.js";
import { pushPendingNotification } from "../ops/pending-notifications.js";
import { scheduleIdleNudge } from "../ops/idle-nudge.js";

/** A short, TTS-friendly line for a finished background op (no markdown, capped
 *  length). Spoken proactively when the user is in voice; the chat UI gets the
 *  full bg_op_completed event separately. */
function toSpokenCompletion(task: string, summary: string, status: string): string {
  const clean = (summary || "").replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim();
  const failed = status === "failed" || status === "cancelled";
  const lead = failed ? "Heads up — that background task ran into trouble" : "Quick update — that background task finished";
  if (!clean) {
    const what = task ? ` (${task.slice(0, 60)})` : "";
    return `${lead}${what}.`;
  }
  return `${lead}: ${clean.slice(0, 280)}`;
}
import { readOp } from "../ops/op-store.js";
import { extractAppReadyUrl, extractArtifactUrl, extractFinalAssistantText } from "./session-bridge-extractors.js";
import { getBus, streamChannel } from "./bus.js";
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

// Per-op stream subscriptions for sidebar progress. Subscribed when a
// non-suppressed op enters queued; unsubscribed on terminal state.
// Throttled to 250ms/op so chat-token streaming (if any non-chat op ever
// turns it on) doesn't flood updateAgentFeed.
const streamSubscriptions = new Map<string, { unsubscribe: () => void; lastEmit: number }>();
const PROGRESS_MIN_INTERVAL_MS = 250;

function ensureStreamForwarder(opId: string, sessionId: string, opType: string): void {
  if (streamSubscriptions.has(opId)) return;
  // Same suppression rule as the canonical-event mapping below — chat_turn
  // is the chat reply stream (lands in the chat box, not the sidebar);
  // agent_spawn surfaces through handler-events' named-agent card;
  // voice_turn lands as TTS audio.
  if (opType === "chat_turn" || opType === "agent_spawn" || opType === "voice_turn") return;

  const entry = { unsubscribe: () => { /* set below */ }, lastEmit: 0 };
  const listener = (msg: unknown): void => {
    const now = Date.now();
    if (now - entry.lastEmit < PROGRESS_MIN_INTERVAL_MS) return;
    const line = extractStreamLine(msg);
    if (!line) return;
    entry.lastEmit = now;
    broadcastToSession(sessionId, {
      type: "bg_op_progress",
      opId,
      line: line.slice(0, 200),
    } as ServerEvent);
  };
  entry.unsubscribe = getBus().subscribe(streamChannel(opId), listener);
  streamSubscriptions.set(opId, entry);
}

function teardownStreamForwarder(opId: string): void {
  const entry = streamSubscriptions.get(opId);
  if (!entry) return;
  entry.unsubscribe();
  streamSubscriptions.delete(opId);
}

function extractStreamLine(msg: unknown): string {
  if (typeof msg === "string") return msg.replace(/\s+/g, " ").trim();
  if (msg && typeof msg === "object") {
    const obj = msg as Record<string, unknown>;
    if (typeof obj.delta === "string") return obj.delta.replace(/\s+/g, " ").trim();
    if (typeof obj.line === "string") return obj.line.replace(/\s+/g, " ").trim();
  }
  return "";
}

export function recordCanonicalEvent(event: CanonicalEvent, projection: "all" | "non-browser" = "all"): void {
  try {
    const browser = projection === "all";
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
    if (op?.type === "chat_turn" || op?.type === "agent_spawn" || op?.type === "voice_turn") {
      // Suppressed from the AGENTS sidebar (these surface elsewhere), but the
      // session→op binding MUST still be released on terminal state. Skipping
      // it leaks every past chat_turn into listOpsForSession forever, which
      // (a) fires the worker-redirect Haiku classifier on EVERY later turn —
      // even on Codex/Grok, since that classifier hardcodes the Anthropic CLI —
      // and (b) poisons the system prompt with phantom "[PARALLEL CONTEXT]"
      // workers. Exactly the leak releaseOpFromSession's doc warns about.
      if (event.type === "state_changed") {
        const to = (event.body as Record<string, unknown> | undefined)?.to;
        if (to === "succeeded" || to === "failed" || to === "cancelled") {
          releaseOpFromSession(event.opId);
          teardownStreamForwarder(event.opId);
        }
      }
      return;
    }

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
          if (browser) broadcastToSession(sessionId, {
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
          // Subscribe to the op's stream channel so adapter-emitted progress
          // (build_app's tool_progress, etc.) surfaces as bg_op_progress in
          // the AGENTS sidebar. Throttled internally. No-op for suppressed
          // op types.
          if (browser && op?.type) ensureStreamForwarder(event.opId, sessionId, op.type);
        } else if (to === "running") {
          if (browser) broadcastToSession(sessionId, {
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
          if (browser) broadcastToSession(sessionId, {
            type: "bg_op_progress",
            opId: event.opId,
            status,
            line: suspension?.detail || "Operation paused",
            resumable: true,
          } as ServerEvent);
        } else if (to === "succeeded" || to === "failed" || to === "cancelled") {
          const status: "completed" | "failed" | "cancelled" = to === "succeeded" ? "completed" : to;
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

          if (browser) broadcastToSession(sessionId, {
            type: "bg_op_completed",
            opId: event.opId,
            status,
            summary,
            filesChanged: [],
            ...(resultUrl ? { resultUrl } : {}),
          } as ServerEvent);
          if (browser) broadcastToSession(sessionId, {
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
          // If the user is in a live voice session, speak the result at the next
          // turn boundary (no-op otherwise — the chat nudge below still fires).
          // The turn machine queues it so it never cuts off an in-flight reply.
          if (browser) {
            proactiveSpeakToSession(sessionId, toSpokenCompletion(task, summary, status));
            scheduleIdleNudge(sessionId, task);
          }
          releaseOpFromSession(event.opId);
          teardownStreamForwarder(event.opId);
        }
        return;
      }
      case "error": {
        const code = (b.code as string | undefined) ?? "error";
        const message = (b.message as string | undefined) ?? "";
        if (browser) broadcastToSession(sessionId, {
          type: "bg_op_progress",
          opId: event.opId,
          line: `! ${code}${message ? ": " + message.slice(0, 120) : ""}`,
        } as ServerEvent);
        return;
      }
      case "iteration_checkpoint": {
        const maxTurns = typeof b.maxTurns === "number" ? b.maxTurns : null;
        const continuing = b.continuing === true;
        if (browser) broadcastToSession(sessionId, {
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
        if (browser) broadcastToSession(sessionId, {
          type: "bg_op_progress",
          opId: event.opId,
          line: `✓ turn ${turnIdx} · ${summary}`,
          ...(typeof usage?.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
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
