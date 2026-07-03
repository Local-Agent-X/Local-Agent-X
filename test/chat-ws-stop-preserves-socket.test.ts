// @vitest-environment happy-dom
//
// CT-9: Stopping one chat must not tear down the shared WebSocket. The `stop`
// message is already per-session (server cancels only that session's op), so
// closing the socket punished every other open chat — their live events during
// the reconnect window were lost until the 60s watchdog healed them. This test
// pins the invariant: stopChat() sends the per-session stop frame but never
// calls close() on the shared socket.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

interface FakeWs {
  readyState: number;
  sent: string[];
  closeCalls: number;
  send: (s: string) => void;
  close: () => void;
}

let stopChat: () => void;
let connectChatWs: () => void;
let fakeSockets: FakeWs[];

function loadModule() {
  fakeSockets = [];
  const g = globalThis as unknown as Record<string, unknown>;

  // Fake WebSocket: records send/close, never touches the network.
  class FakeWebSocket implements FakeWs {
    static OPEN = 1;
    readyState = 1; // OPEN
    sent: string[] = [];
    closeCalls = 0;
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      fakeSockets.push(this);
    }
    send(s: string) {
      this.sent.push(s);
    }
    close() {
      this.closeCalls++;
    }
  }
  g.WebSocket = FakeWebSocket;

  g.AUTH_TOKEN = "test-token";
  g.API = "";
  g.activeChat = null;
  g.stopSpeaking = () => {};
  g.apiFetch = () => Promise.resolve();
  g.esc = (s: string) => s;
  g.handleChatWsMessage = () => {}; // dispatcher lives in a sibling module
  // Minimal per-session stream store — only endTurn/inflightOps are hit by
  // stopChat + the module-level watchdog interval.
  const endTurnCalls: Array<[string, string]> = [];
  g.ChatStreamStore = {
    endTurn: (id: string, reason: string) => {
      endTurnCalls.push([id, reason]);
    },
    inflightOps: () => [] as unknown[],
    bumpActivity: () => {},
    isActive: () => false,
    isStreaming: () => false,
    resolveApprovalLocal: () => {},
  };
  (g.ChatStreamStore as Record<string, unknown>).__endTurnCalls = endTurnCalls;

  const src = readFileSync(join(here, "../public/js/chat-ws.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(src + "\nreturn { stopChat, connectChatWs };");
  ({ stopChat, connectChatWs } = factory() as {
    stopChat: () => void;
    connectChatWs: () => void;
  });
}

describe("CT-9: stopChat preserves the shared WebSocket", () => {
  beforeEach(() => {
    loadModule();
  });

  it("sends a per-session stop frame but never closes the shared socket", () => {
    connectChatWs(); // creates the fake shared socket (readyState OPEN)
    const ws = fakeSockets[0];
    expect(ws).toBeTruthy();
    ws.sent.length = 0; // ignore any subscribe/reconnect frames from onopen

    (globalThis as unknown as Record<string, unknown>).activeChat = { id: "chat-A" };
    stopChat();

    const stopFrames = ws.sent
      .map((s) => JSON.parse(s) as { type: string; sessionId?: string })
      .filter((m) => m.type === "stop");
    expect(stopFrames).toHaveLength(1);
    expect(stopFrames[0].sessionId).toBe("chat-A");

    // The invariant: the shared socket must stay open for every other session.
    expect(ws.closeCalls).toBe(0);
    expect(ws.readyState).toBe(1); // still OPEN
  });
});
