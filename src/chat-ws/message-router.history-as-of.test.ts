/**
 * `subscribe` carries the time the client read its history (historyAsOf, from
 * GET /api/sessions/<id>) to the replay, which then skips a finished turn that
 * history already holds — the phone's duplicate reply (field 2026-10-13).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { WebSocket } from "ws";
import type { ServerEvent } from "../types.js";

const { attachMessageRouter } = await import("./message-router.js");
const { buildManager } = await import("./manager.js");
const { activeChats, markTurnPersisted } = await import("./state.js");

function subscribe(frame: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const sent: string[] = [];
  let onMessage: ((data: Buffer) => unknown) | null = null;
  const ws = {
    readyState: 1,
    send: (f: string) => { sent.push(f); },
    on: (evt: string, cb: (data: Buffer) => unknown) => { if (evt === "message") onMessage = cb; },
  } as unknown as WebSocket;
  attachMessageRouter({ ws, subscriptions: new Set<string>() });
  return Promise.resolve(onMessage!(Buffer.from(JSON.stringify({ type: "subscribe", ...frame }))))
    .then(() => sent.map((f) => JSON.parse(f) as Record<string, unknown>));
}

const replayed = (frames: Array<Record<string, unknown>>) => frames.filter((f) => f.type === "event");

beforeEach(() => activeChats.clear());

describe("subscribe passes what the client holds to the replay", () => {
  it("a client whose history was read after the turn was saved gets no replay of it", async () => {
    const { onEvent } = buildManager().startChat("chat-h");
    onEvent({ type: "chat_op_started", opId: "op-h" } as ServerEvent);
    onEvent({ type: "stream", delta: "the reply" } as ServerEvent);
    onEvent({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } as ServerEvent);
    markTurnPersisted("chat-h");
    const persistedAt = activeChats.get("chat-h")!.persistedAt!;

    expect(replayed(await subscribe({ sessionId: "chat-h", historyAsOf: persistedAt + 1 }))).toEqual([]);
    expect(replayed(await subscribe({ sessionId: "chat-h", doneOpId: "op-h" }))).toEqual([]);
    expect(replayed(await subscribe({ sessionId: "chat-h" })).length).toBeGreaterThan(0);
  });
});
