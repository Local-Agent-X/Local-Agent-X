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
import { broadcastToSession, getSessionForOp, getTaskForOp, releaseOpFromSession } from "../ops/session-bridge.js";
import { pushPendingNotification } from "../ops/pending-notifications.js";
import { scheduleIdleNudge } from "../ops/idle-nudge.js";
import { readOp } from "../ops/op-store.js";
import { readOpMessages } from "./store.js";
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

// Strip trailing chars that are never valid URL tails — bold/italic markdown
// (`**`, `*`, `_`), sentence punctuation, closing brackets. Live failure
// 2026-05-23: agent emitted `**APP_READY: <url>**`, regex captured the
// trailing `**`, the rendered sidebar link 404'd while the apps-page link
// worked.
function trimUrlNoise(url: string): string {
  return url.replace(/[*)\]>.,;:'"`!?]+$/, "");
}

/** Scan an op's persisted messages for the final assistant turn and
 *  pull out the APP_READY: <url> marker the build_app adapter emits.
 *  Returns the URL string, or undefined if the marker isn't present. */
function extractAppReadyUrl(opId: string): string | undefined {
  try {
    const messages = readOpMessages(opId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const content = m.content as { text?: string } | string | undefined;
      const text = typeof content === "string" ? content : content?.text;
      if (!text) continue;
      const match = text.match(/APP_READY:\s*(\S+)/);
      if (match) return trimUrlNoise(match[1]);
      return undefined;
    }
  } catch { /* malformed op-messages — return undefined */ }
  return undefined;
}

/** Scan an op's persisted tool_result messages for "Created <path>" /
 *  "Wrote ... to <path>" markers from the artifact-creating tools
 *  (document_create, presentation_create, pdf_create, spreadsheet_create,
 *  write, create_page, etc.). Returns the MOST RECENT openable artifact's
 *  workspace-relative path, or undefined if none found. Strict
 *  workspace-only filter — host paths outside the workspace are skipped
 *  so the sidebar never offers a link the static handler can't serve.
 *
 *  Used by the generic completion path: any worker op (not just
 *  app_build) gets the same "↗ Open" affordance in the AGENTS sidebar.
 *  The user's framing: "any agent creation wired into that — apps,
 *  landing pages, ppt, docs everything." This is the same wiring,
 *  just with a broader marker set.
 */
function extractArtifactUrl(opId: string, workspaceDir: string): string | undefined {
  try {
    const messages = readOpMessages(opId);
    // Walk newest-first; first hit wins. Tool outputs we recognize:
    //   "Created /abs/path/foo.docx (...)"           → document_*, presentation_*, pdf_*, spreadsheet_*
    //   "Wrote N bytes to /abs/path/foo.html"        → write
    //   "Edited /abs/path/foo.css"                   → edit
    //   "App built ... Open: http://127.0.0.1:.../" → build_app (separate APP_READY path also works)
    // We deliberately don't try to extract from prose — only from
    // structured tool_result strings, which are stable.
    const wsAbs = workspaceDir.endsWith("/") ? workspaceDir : workspaceDir + "/";
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "tool_result") continue;
      const content = m.content as { text?: string; result?: string } | string | undefined;
      const text = typeof content === "string"
        ? content
        : (content?.result ?? content?.text ?? "");
      if (!text) continue;
      // Most precise: a build_app-style explicit URL line.
      const urlMatch = String(text).match(/Open:\s*(https?:\/\/\S+)/);
      if (urlMatch) return trimUrlNoise(urlMatch[1]);
      // Generic "Created <abs-path>" / "Wrote N bytes to <abs-path>" patterns.
      const created = String(text).match(/(?:Created|Wrote (?:\d+ bytes? )?to|Edited)\s+(\/\S+)/);
      if (!created) continue;
      const absPath = trimUrlNoise(created[1]);
      // Workspace-bound only — sidebar links go through the static handler.
      if (!absPath.startsWith(wsAbs)) continue;
      const rel = absPath.slice(wsAbs.length);
      // For HTML/index files we want the directory link, not the file.
      if (rel.endsWith("/index.html")) return "/apps/" + rel.slice(0, -"/index.html".length) + "/";
      // /apps/ static handler serves anything under workspace/apps/ — for
      // standalone workspace files (workspace/foo.docx) link via a
      // /workspace/ path. The handler may not serve all of these yet, but
      // the link IS a stable user-readable hint at where the artifact
      // landed; click-through works for HTML, downloads otherwise.
      return rel.startsWith("apps/") ? "/" + rel : "/workspace/" + rel;
    }
  } catch { /* malformed op-messages — return undefined */ }
  return undefined;
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
          // Subscribe to the op's stream channel so adapter-emitted progress
          // (build_app's tool_progress, etc.) surfaces as bg_op_progress in
          // the AGENTS sidebar. Throttled internally. No-op for suppressed
          // op types.
          if (op?.type) ensureStreamForwarder(event.opId, sessionId, op.type);
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
          //      document_create / presentation_create / pdf_create /
          //      spreadsheet_create / write / create_page / etc.
          //
          // The generic scan is gated to `status === "completed"` so a
          // failed run doesn't surface a half-written artifact as a link.
          let resultUrl: string | undefined;
          if (status === "completed") {
            if (op?.type === "app_build") {
              resultUrl = extractAppReadyUrl(event.opId);
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

          broadcastToSession(sessionId, {
            type: "bg_op_completed",
            opId: event.opId,
            status,
            summary,
            filesChanged: [],
            ...(resultUrl ? { resultUrl } : {}),
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
          teardownStreamForwarder(event.opId);
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
        const tools = (b.tools as { tool: string; status: string }[] | undefined) ?? [];
        // Lead with what the worker actually DID this turn — the tool names,
        // each flagged if it errored — instead of an opaque message count.
        // Bare "turn N" with no tools means a pure text/reasoning turn.
        const summary = tools.length > 0
          ? tools.map((t) => (t.status === "error" ? `${t.tool} ✗` : t.tool)).join(", ")
          : "thinking";
        broadcastToSession(sessionId, {
          type: "bg_op_progress",
          opId: event.opId,
          line: `✓ turn ${turnIdx} · ${summary}`,
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
