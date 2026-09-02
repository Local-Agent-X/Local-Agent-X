// Live-turn keepalive for the per-chat channel: the interval that emits
// `op_heartbeat` while a turn is in flight, plus the derivation of what that
// beat REPORTS. Split out of manager.ts (which sits at the file-size limit)
// when the beat stopped being payload-free — the manager owns turn lifecycle,
// this owns the keepalive.
//
// Everything here reads state the ActiveChat entry ALREADY accumulates. The
// beat is telemetry about a turn, never a reason to make a turn track more.

import type { ServerEvent } from "../types.js";
import { activeChats, type ActiveChat } from "./state.js";
import { broadcastToSession } from "./broadcast.js";

// Keepalive cadence for live turns. The client's stuck-stream watchdog
// (public/js/chat-ws.js) fires reconnect_op after 60s without events, so a
// single long tool call (a build, npm install) used to trigger needless full
// replays. 20s keeps the client's activity clock fresh with 3x margin under
// that 60s threshold.
const HEARTBEAT_INTERVAL_MS = 20_000;

// Belt-and-suspenders lifetime bound on the keepalive (2026-07-13 audit,
// skeptic finding): if an ActiveChat entry leaks — an error path where `done`
// never lands (the known one: emitTurnError bypassing onEvent; its root fix
// lives in run-chat-turn's error path) — an immortal heartbeat would keep the
// client's activity clock fresh forever and defeat the watchdog's
// reconnect_op recovery of that session's phantom stream. 4h is generously
// above any plausible turn, including multi-hour agentic builds, so healthy
// turns never hit it; any leaked entry stops masking itself within one
// interval past the cap.
const HEARTBEAT_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;

/** The `op_heartbeat` member of ServerEvent. Naming the member rather than
 *  the union is what lets the optional fields below be assigned one at a time
 *  without a cast. */
type HeartbeatEvent = Extract<ServerEvent, { type: "op_heartbeat" }>;

/** Name of the tool the turn is currently inside, or undefined when none is
 *  running. Derived from state the entry already holds: the turn must be
 *  INSIDE a tool phase, and the answer is then the most recent buffered
 *  `tool_start` that no later `tool_end` closed.
 *
 *  The phase gate is the correctness half. A buffered `tool_start` proves a
 *  tool was SEEN to start, never that it is still open — the `tool_end` can
 *  be lost outright: audit-tool-call.ts emits it only after evaluateThreat /
 *  applyBudget / firePostHook (USER-configured) / recordUsage, and a throw in
 *  any of those skips the emit while chat-tool-dispatcher's catch turns it
 *  into an error result and the turn CONTINUES. Read from the buffer alone,
 *  that dangling start made every later beat name a dead tool for the rest of
 *  the turn — mid-answer and mid-reasoning included (skeptic finding,
 *  2026-07-28). `chat.runBoundary` is the manager's existing proof of the
 *  opposite: false means the turn appended text AFTER the last tool event, so
 *  nothing is in flight and the dangling start is history. O(1), and it skips
 *  the scan outright for every beat sent while the turn is writing.
 *
 *  The pairing is the other half. Tool batches run CONCURRENTLY (adjacent
 *  parallel-safe grouping in chat-tool-dispatcher.dispatchBatch), so the
 *  NEWEST tool_* event is not the answer — a quick sibling's `tool_end` lands
 *  while the long call, the one a 20s beat exists to describe, is still
 *  running. Identity is the toolCallId when the emitter set one (it's
 *  optional on the wire contract); emitters that don't fall back to the tool
 *  name, and the close COUNT per key keeps that fallback exact for a tool
 *  that ran repeatedly.
 *
 *  Two mispairings survive, both bounded and both needing an event the
 *  canonical emitters don't produce: two concurrent id-less calls to the same
 *  tool (every canonical emitter sets toolCallId), and a start left dangling
 *  by a lost tool_end when a LATER batch completes with no text in between.
 *  The buffer carries no batch marker, so separating those two would need
 *  per-turn open-call state on the ActiveChat instead of a derivation — the
 *  wrong trade for a keepalive, and the lost tool_end is a tool-execution
 *  contract bug in its own right.
 *
 *  O(events) once per 20s, over a list nothing floods any more: stream and
 *  reasoning deltas fold into the accumulators, and a repeated tool_progress
 *  supersedes its own buffered line instead of appending (manager.ts). */
function runningTool(chat: ActiveChat): string | undefined {
  if (!chat.runBoundary) return undefined;
  const closed = new Map<string, number>();
  for (let i = chat.events.length - 1; i >= 0; i--) {
    const event = chat.events[i];
    if (event.type === "tool_end") {
      const key = event.toolCallId ?? event.toolName;
      closed.set(key, (closed.get(key) ?? 0) + 1);
    } else if (event.type === "tool_start") {
      const key = event.toolCallId ?? event.toolName;
      const pending = closed.get(key) ?? 0;
      if (pending > 0) {
        closed.set(key, pending - 1); // this start is the one that end closed
        continue;
      }
      return event.toolName;
    }
  }
  return undefined;
}

/** One word for what the turn is doing, or undefined when the manager cannot
 *  honestly say. A tool in flight wins; otherwise the lane of the run the
 *  turn last appended to names the activity (the client can then say
 *  "writing" vs "thinking" across a silent stretch instead of "still
 *  working"). */
function currentPhase(chat: ActiveChat, activeTool: string | undefined): string | undefined {
  if (activeTool) return "tool";
  // runBoundary means a tool event — or a consumed inject — landed AFTER the
  // last text append, so the tail run is history, not the present: the turn
  // is back at the provider awaiting its next output and the manager has no
  // name for that. Report nothing rather than a stale lane. (An inject run is
  // always followed by runBoundary:true, so the tail below is a text lane.)
  if (chat.runBoundary) return undefined;
  const tail = chat.runs[chat.runs.length - 1];
  return tail && tail.lane !== "inject" ? tail.lane : undefined;
}

/** The beat this turn would send right now. Every field is omitted unless
 *  known, so a channel with nothing to report still emits the bare
 *  `{ type: "op_heartbeat" }` the client has always handled.
 *
 *  `iteration` is deliberately never set: the agentic loop's iteration
 *  counter lives in canonical-loop and reaches nothing the chat-ws layer
 *  holds. Plumbing it down here would be new per-turn bookkeeping in service
 *  of a keepalive — the wrong trade. */
export function heartbeatEvent(chat: ActiveChat): HeartbeatEvent {
  const activeTool = runningTool(chat);
  const phase = currentPhase(chat, activeTool);
  const event: HeartbeatEvent = { type: "op_heartbeat" };
  if (chat.opId) event.opId = chat.opId;
  if (phase) event.phase = phase;
  if (activeTool) event.activeTool = activeTool;
  return event;
}

/** Start the keepalive for one live turn; returns the interval so the
 *  manager's `done` branch can stop it promptly (clearInterval is idempotent
 *  with the self-check below).
 *
 *  Broadcast-only — a beat is never pushed into chat.events (replay noise)
 *  and never routed through onEvent. The identity check makes the interval
 *  self-cleaning across every exit path: natural done, terminateChat (state.ts
 *  marks done), and overwrite by a successor startChat — no cross-module
 *  wiring needed. The lifetime cap backstops entry-leak paths where done
 *  never lands. */
export function startHeartbeat(chat: ActiveChat): NodeJS.Timeout {
  const heartbeat = setInterval(() => {
    if (
      chat.done ||
      activeChats.get(chat.sessionId) !== chat ||
      Date.now() - chat.startedAt > HEARTBEAT_MAX_LIFETIME_MS
    ) {
      clearInterval(heartbeat);
      return;
    }
    broadcastToSession(chat.sessionId, heartbeatEvent(chat));
  }, HEARTBEAT_INTERVAL_MS);
  // Never hold the process open for a keepalive.
  heartbeat.unref?.();
  return heartbeat;
}
