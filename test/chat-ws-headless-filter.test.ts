/**
 * Eval sessions (/api/eval/run, prefix `eval-`) run a real chat turn to observe
 * tool routing but must never reach a browser. A burst of eval calls once
 * announced their throwaway sessions over the chat WebSocket and the UI rendered
 * the test prompts into the user's open chat. broadcastActiveChats /
 * broadcastToSession now filter `eval-` at the source.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { WebSocket } from "ws";
import {
  clients,
  activeChats,
  broadcastToSession,
  broadcastActiveChats,
  type ActiveChat,
} from "../src/chat-ws/state.js";

function fakeWs(): { ws: WebSocket; sent: string[] } {
  const sent: string[] = [];
  const ws = { readyState: 1, send: (s: string) => { sent.push(s); } } as unknown as WebSocket;
  return { ws, sent };
}

function fakeChat(sessionId: string): ActiveChat {
  return { sessionId, events: [], abortController: new AbortController(), startedAt: 1, done: false };
}

afterEach(() => { clients.clear(); activeChats.clear(); });

describe("chat-ws headless (eval-) session filtering", () => {
  it("broadcastActiveChats omits eval- sessions, keeps real ones", () => {
    activeChats.set("chat-real", fakeChat("chat-real"));
    activeChats.set("eval-throwaway", fakeChat("eval-throwaway"));
    const { ws, sent } = fakeWs();
    clients.set(ws, new Set());

    broadcastActiveChats();

    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]) as { type: string; sessionIds: string[] };
    expect(msg.type).toBe("active_chats");
    expect(msg.sessionIds).toEqual(["chat-real"]);
  });

  it("broadcastToSession never sends for an eval- session, even to a subscriber", () => {
    const { ws, sent } = fakeWs();
    clients.set(ws, new Set(["eval-throwaway", "chat-real"]));

    broadcastToSession("eval-throwaway", { type: "stream", delta: "secret test prompt" } as never);
    expect(sent).toHaveLength(0);

    broadcastToSession("chat-real", { type: "stream", delta: "real" } as never);
    expect(sent).toHaveLength(1);
  });
});
