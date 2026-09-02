/**
 * The on-connect active_chats snapshot (connection-setup.ts) must be the SAME
 * filtered listing broadcastActiveChats sends. It used to serialize the raw
 * activeChats map — so a fresh page load received headless (eval_/
 * skill-review-/dream-) and cron- ids even though the live broadcast filtered
 * them, and the browser minted a sidebar row for every id in the snapshot
 * (chat-stream-store-approvals.js setActiveSidebarSet → ensure()): fake chats
 * on every reload while a background job was running. Both paths now consume
 * chat-ws/broadcast.ts listActiveChatIds (one definition of the listing).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type { WebSocket } from "ws";
import { randomId } from "../src/util/ids.js";

// setImmediate hook — reconciling pending process relays needs op-store
// journal state that doesn't exist in this test's throwaway home dir.
vi.mock("../src/canonical-loop/public/process-relay.js", () => ({
  reconcileAllPendingProcessRelays: vi.fn(),
}));
// Replayed AGENTS-card ops are another test's concern; keep the dynamic
// import from dragging the autopilot module graph into this one.
vi.mock("../src/autopilot/loop.js", () => ({
  listActiveAutopilotOps: () => [],
}));

const { clients, activeChats } = await import("../src/chat-ws/state.js");
const { setupConnection } = await import("../src/chat-ws/connection-setup.js");

function fakeChat(sessionId: string) {
  return { sessionId, events: [], abortController: new AbortController(), startedAt: 1, done: false };
}

function fakeWs() {
  const sent: string[] = [];
  const closeHandlers: Array<() => void> = [];
  const ws = {
    readyState: 1,
    send: (s: string) => { sent.push(s); },
    ping: () => {},
    on: (event: string, cb: () => void) => {
      if (event === "close") closeHandlers.push(cb);
    },
  } as unknown as WebSocket;
  return { ws, sent, close: () => { for (const cb of closeHandlers) cb(); } };
}

afterEach(() => { clients.clear(); activeChats.clear(); });

describe("connection-setup on-connect active_chats snapshot", () => {
  it("sends only listable chats: chat-/ide- in, headless + cron- + done out", () => {
    for (const id of [
      "chat-real",
      "ide-todo-app",
      `cron-daily-report-${Date.now()}`, // real minter shape (cron-runner.ts)
      "dream-123",
      "skill-review-456",
      randomId("eval"), // real minter (routes/chat.ts randomId("eval"))
    ]) {
      activeChats.set(id, fakeChat(id) as never);
    }
    const doneChat = fakeChat("chat-finished");
    doneChat.done = true;
    activeChats.set("chat-finished", doneChat as never);

    const { ws, sent, close } = fakeWs();
    try {
      setupConnection(ws);

      expect(sent.length).toBeGreaterThanOrEqual(1);
      const snapshot = JSON.parse(sent[0]) as { type: string; sessionIds: string[] };
      expect(snapshot.type).toBe("active_chats");
      expect(snapshot.sessionIds).toEqual(["chat-real", "ide-todo-app"]);
    } finally {
      close(); // clears the 24h max-age timer + heartbeat interval
    }
  });
});
