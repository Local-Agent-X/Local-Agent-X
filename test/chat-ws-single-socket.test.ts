// @vitest-environment happy-dom
//
// One page, one chat socket (2026-09-21).
//
// The browser's heartbeat detects a half-open connection and calls close().
// That is a request, not an act: the handshake needs the peer, and while the
// server's event loop was blocked for 218s the socket stayed in CLOSING and
// went on handing frames to onmessage. Meanwhile the reconnect ran and a
// second socket subscribed to the same session. Two sockets, one store, every
// text delta applied twice.
//
// Two rules keep a page to one socket, and they are what these drive:
//   - a socket still CONNECTING is not replaced (it would open, subscribe,
//     and deliver everything a second time);
//   - retiring a socket detaches its handlers, so whatever it still delivers
//     changes nothing — and the reconnect no longer waits on an onclose that
//     may never arrive.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

interface FakeSocket {
  readyState: number;
  sent: string[];
  closed: boolean;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(p: string): void;
  close(): void;
  open(): void;
}

let built: FakeSocket[];
/** Frames the page actually absorbed — the store's ingress, stubbed. */
let absorbed: string[];

function makeFakeSocket(): FakeSocket {
  const ws: FakeSocket = {
    readyState: CONNECTING,
    sent: [],
    closed: false,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(p) { ws.sent.push(p); },
    // close() only ASKS. A peer that never answers leaves the socket in
    // CLOSING, still able to deliver — that is the whole bug.
    close() { ws.closed = true; ws.readyState = CLOSING; },
    open() { ws.readyState = OPEN; ws.onopen?.(); },
  };
  return ws;
}

// The module defines `window.chatWs` as a non-configurable accessor, so each
// load needs its own `window`. Everything else it reads at load time is passed
// in as a parameter rather than left on globalThis — one test's socket factory
// must not be visible to the next.
const LOAD_SCOPE = [
  "window", "WebSocket", "AUTH_TOKEN", "API", "activeChat", "agentFeedsData",
  "ChatStreamStore", "handleChatWsMessage", "handleDurableApprovalReply",
  "rediscoverPendingApprovals", "isTerminalStatus", "updateStreamUI", "location",
];

interface LoadedChatWs {
  connectChatWs(): void;
  retireChatWs(reason: string): void;
  getSocket(): FakeSocket | null;
}

function loadChatWs(): LoadedChatWs {
  const src = readFileSync(join(here, "../public/js/chat-ws.js"), "utf8");
  const FakeWebSocket = Object.assign(
    function () { const s = makeFakeSocket(); built.push(s); return s; },
    { CONNECTING, OPEN, CLOSING, CLOSED },
  );
  const tail = "\nreturn { connectChatWs, retireChatWs, getSocket: () => chatWs };";
  // eslint-disable-next-line no-new-func
  const factory = new Function(...LOAD_SCOPE, src + tail);
  return factory(
    {},
    FakeWebSocket,
    "t",
    "",
    null,
    null,
    { inflightOps: () => [], bumpActivity() {} },
    (e: { data: string }) => { absorbed.push(e.data); },
    () => false,
    async () => {},
    () => true,
    () => {},
    { host: "localhost:3000" },
  ) as LoadedChatWs;
}

let api: LoadedChatWs;

beforeEach(() => {
  vi.useFakeTimers();
  built = [];
  absorbed = [];
  api = loadChatWs();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a page never runs two chat sockets", () => {
  it("does not replace a socket that is still CONNECTING", () => {
    api.connectChatWs();
    expect(built).toHaveLength(1);
    expect(built[0].readyState).toBe(CONNECTING);

    // The reconnect timer firing while the handshake is still in flight. The
    // pre-fix guard only knew OPEN, so this built a second socket — and the
    // first still opened, still subscribed, and delivered everything twice.
    api.connectChatWs();
    api.connectChatWs();
    expect(built).toHaveLength(1);
  });

  it("does not replace an OPEN socket", () => {
    api.connectChatWs();
    built[0].open();
    api.connectChatWs();
    expect(built).toHaveLength(1);
  });

  it("a retired socket still in CLOSING delivers nothing", () => {
    api.connectChatWs();
    const orphan = built[0];
    orphan.open();

    api.retireChatWs("test");
    expect(orphan.closed).toBe(true);
    // The peer is blocked, so the handshake has not completed.
    expect(orphan.readyState).toBe(CLOSING);

    // Frames the socket had already queued keep arriving.
    orphan.onmessage?.({ data: '{"type":"event"}' });
    expect(absorbed).toHaveLength(0);
  });

  it("reconnects after a retire without waiting for onclose", () => {
    api.connectChatWs();
    built[0].open();
    api.retireChatWs("half-open");

    // onclose never fires — the peer never finished the handshake.
    vi.advanceTimersByTime(3000);
    expect(built).toHaveLength(2);
    expect(api.getSocket()).toBe(built[1]);
  });

  it("schedules exactly one reconnect when a retire and an onclose both land", () => {
    api.connectChatWs();
    const first = built[0];
    first.open();
    const closeHandler = first.onclose;

    api.retireChatWs("half-open");
    // A late onclose for the socket we already retired must not add a second
    // reconnect — two timers is two sockets.
    closeHandler?.();
    vi.advanceTimersByTime(3000);

    expect(built).toHaveLength(2);
  });

  it("retires a handshake that never completes", () => {
    api.connectChatWs();
    const stuck = built[0];
    expect(stuck.readyState).toBe(CONNECTING);

    // Without a deadline the CONNECTING guard would park the page on a socket
    // that can never open, and no reconnect would ever run.
    vi.advanceTimersByTime(10_000);
    expect(stuck.closed).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(built).toHaveLength(2);
  });

  it("a superseded socket that opens late neither subscribes nor delivers", () => {
    api.connectChatWs();
    const orphan = built[0];
    api.retireChatWs("test");
    vi.advanceTimersByTime(3000);
    expect(built).toHaveLength(2);

    // The orphan's handshake finally completes, long after we moved on.
    orphan.readyState = OPEN;
    orphan.onopen?.();
    orphan.onmessage?.({ data: '{"type":"event"}' });

    expect(orphan.sent).toHaveLength(0);
    expect(absorbed).toHaveLength(0);
  });
});
