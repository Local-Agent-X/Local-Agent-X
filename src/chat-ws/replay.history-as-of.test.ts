/** A subscriber that just rendered persisted history must not get a finished
 *  turn replayed that the history already holds — the phone appended it a
 *  second time (field 2026-10-13). Anything less certain still replays: a
 *  duplicate is recoverable, a lost reply is not. */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { WebSocket } from "ws";
import type { ServerEvent } from "../types.js";
import { buildManager } from "./manager.js";
import { activeChats, clients, markTurnPersisted } from "./state.js";
import { replayBufferedEvents, type SubscriberHas } from "./replay.js";

function makeWs(): { ws: WebSocket; frames: () => Array<{ event?: { type?: string } }> } {
  const sent: string[] = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: vi.fn((p: string) => { sent.push(p); }) } as unknown as WebSocket;
  return { ws, frames: () => sent.map((p) => JSON.parse(p)) };
}

const replayedTypes = (sid: string, has: SubscriberHas = {}): string[] => {
  const { ws, frames } = makeWs();
  replayBufferedEvents(ws, sid, has);
  return frames().map((f) => f.event?.type ?? "");
};

beforeEach(() => {
  activeChats.clear();
  clients.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

function finishedTurn(sid: string, opId = "op-1"): void {
  const { onEvent } = buildManager().startChat(sid);
  onEvent({ type: "chat_op_started", opId } as ServerEvent);
  onEvent({ type: "stream", delta: "the reply" } as ServerEvent);
  onEvent({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } as ServerEvent);
}

describe("replayBufferedEvents — a subscriber that already holds the finished turn", () => {
  it("skips a finished turn persisted before the history was read", () => {
    finishedTurn("s-a");
    markTurnPersisted("s-a"); // t = 1_000_000
    expect(replayedTypes("s-a", { historyAsOf: 1_000_001 })).toEqual([]);
  });

  it("replays when the history was read before (or in the same ms as) the persist — it lacks the reply", () => {
    finishedTurn("s-b");
    markTurnPersisted("s-b");
    expect(replayedTypes("s-b", { historyAsOf: 999_999 })).toContain("stream");
    expect(replayedTypes("s-b", { historyAsOf: 1_000_000 })).toContain("stream");
  });

  it("replays a finished turn not yet persisted (done is emitted before the persist)", () => {
    finishedTurn("s-c");
    expect(replayedTypes("s-c", { historyAsOf: 2_000_000 })).toContain("stream");
  });

  it("replays a turn still running, whatever the history time", () => {
    const { onEvent } = buildManager().startChat("s-d");
    onEvent({ type: "stream", delta: "partial" } as ServerEvent);
    markTurnPersisted("s-d"); // a running turn is never marked
    expect(activeChats.get("s-d")!.persistedAt).toBeUndefined();
    expect(replayedTypes("s-d", { historyAsOf: 2_000_000 })).toContain("stream");
  });

  it("a subscriber that sends no historyAsOf (the web UI) replays as before", () => {
    finishedTurn("s-e");
    markTurnPersisted("s-e");
    expect(replayedTypes("s-e")).toEqual(expect.arrayContaining(["stream", "done"]));
  });

  it("skips a finished turn whose done the subscriber already received (reconnect with the chat open)", () => {
    finishedTurn("s-f", "op-live");
    expect(replayedTypes("s-f", { doneOpId: "op-live" })).toEqual([]);
  });

  it("replays when the subscriber's last done was an earlier turn", () => {
    finishedTurn("s-g", "op-new");
    expect(replayedTypes("s-g", { doneOpId: "op-old" })).toContain("stream");
  });
});
