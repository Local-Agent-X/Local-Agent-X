/**
 * bridge-wiring routing — the fix that made Telegram/WhatsApp-originated
 * background ops visible in the local AGENTS sidebar.
 *
 * Bridge ops carry sessionIds (`tg-XXX`, `wa-XXX`) that no browser client
 * ever subscribes to. The AGENTS sidebar is a GLOBAL surface, so bg_op_*
 * events must fan out to ALL clients regardless of subscription, while
 * everything else stays per-session. This locks both halves of that rule so
 * a future routing refactor can't silently re-hide bridge ops.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebSocket } from "ws";
import type { ServerEvent } from "../types.js";
import { wireBridgeBroadcasters } from "./bridge-wiring.js";
import { clients, activeChats } from "./state.js";
import { broadcastToSession as driveSessionBroadcaster } from "../ops/session-bridge.js";

const TG_SESSION = "tg-12345"; // a bridge session no browser client subscribes to

function fakeClient(subscriptions: string[]): { ws: WebSocket; sent: string[] } {
  const sent: string[] = [];
  const ws = { readyState: 1, send: (p: string) => { sent.push(p); } } as unknown as WebSocket;
  clients.set(ws, new Set(subscriptions));
  return { ws, sent };
}

function bgEvent(): ServerEvent {
  return { type: "bg_op_started", opId: "op-1", task: "from telegram", provider: "autopilot" };
}

function registerChat(sessionId: string): { events: ServerEvent[] } {
  const chat = {
    sessionId,
    events: [] as ServerEvent[],
    abortController: new AbortController(),
    startedAt: Date.now(),
    done: false,
    streamText: "",
    sawStream: false,
    reasoningText: "",
    sawReasoning: false,
    toolsSinceText: false,
    runs: [],
    runBoundary: false,
  };
  activeChats.set(sessionId, chat);
  return chat;
}

beforeEach(() => {
  clients.clear();
  activeChats.clear();
  vi.restoreAllMocks();
  wireBridgeBroadcasters();
});

describe("bridge bg_op routing", () => {
  it("fans bg_op_* events out to clients that never subscribed to the bridge session", () => {
    const a = fakeClient([]);            // subscribes to nothing
    const b = fakeClient(["web-1"]);     // subscribes to a different session

    driveSessionBroadcaster(TG_SESSION, bgEvent());

    // Both clients receive it despite neither subscribing to tg-12345.
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    const payload = JSON.parse(a.sent[0]);
    expect(payload).toMatchObject({ type: "event", sessionId: TG_SESSION, event: { type: "bg_op_started" } });
  });

  it("keeps non-bg_op events per-session (an unsubscribed client gets nothing)", () => {
    const a = fakeClient([]); // not subscribed to TG_SESSION

    driveSessionBroadcaster(TG_SESSION, { type: "error", message: "scoped" });

    expect(a.sent).toHaveLength(0);
  });

  it("still delivers non-bg_op events to a client subscribed to that session", () => {
    const a = fakeClient([TG_SESSION]);

    driveSessionBroadcaster(TG_SESSION, { type: "error", message: "scoped" });

    expect(a.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0])).toMatchObject({ type: "event", sessionId: TG_SESSION, event: { type: "error" } });
  });

  it("does not double-send a bg_op event to a subscribed client (one broadcast path, not both)", () => {
    const a = fakeClient([TG_SESSION]); // subscribed AND would match broadcastAll

    driveSessionBroadcaster(TG_SESSION, bgEvent());

    // broadcastAll path only — exactly one frame, not one per routing branch.
    expect(a.sent).toHaveLength(1);
  });
});

describe("bridge replay-buffer cap (CT-8)", () => {
  it("trims the replay buffer to the same 500→400 cap manager.onEvent enforces", () => {
    // A long-running worker at a fast throttle stuffs thousands of bg_op
    // progress events at one bridge session. Without the cap the replay
    // buffer grows unbounded and every event is re-sent to each late
    // subscriber. Pre-fix (a bare chat.events.push) this length is 3600.
    const chat = registerChat(TG_SESSION);

    for (let i = 0; i < 3600; i++) {
      driveSessionBroadcaster(TG_SESSION, {
        type: "bg_op_progress",
        opId: "op-1",
        line: `tick ${i}`,
      });
    }

    expect(chat.events.length).toBeLessThanOrEqual(500);
    // And the newest events are the ones retained (trim keeps the tail).
    const last = chat.events[chat.events.length - 1];
    expect(last).toMatchObject({ type: "bg_op_progress", line: "tick 3599" });
  });
});
