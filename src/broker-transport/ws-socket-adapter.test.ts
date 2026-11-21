// WsSocketAdapter heartbeat tests — a fake `ws` WebSocket + fake timers prove the
// liveness ping: a pong keeps the socket, a missed pong terminates it (so 'close'
// fires and the presence supervisor re-dials). This is the guard against the
// silent-death class: system sleep / NAT drops kill the socket with NO close event
// (2026-08-23 live incident: a 6-hour zombie presence).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WsSocketAdapter, openBrokerSocket } from "./ws-socket-adapter.js";
import { BROKER_PING, BROKER_PONG } from "./vendor/protocol.js";
import type WebSocket from "ws";

const OPEN = 1;

class FakeWs extends EventEmitter {
  readyState = OPEN;
  pings = 0;
  terminated = 0;
  closed = 0;
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.terminated += 1;
    this.emit("close", 1006, Buffer.from(""));
  }
  close(): void {
    this.closed += 1;
    this.emit("close", 1000, Buffer.from(""));
  }
  sent: string[] = [];
  send(text: string): void {
    this.sent.push(text);
  }
}

function makeAdapter() {
  const ws = new FakeWs();
  const adapter = new WsSocketAdapter(ws as unknown as WebSocket);
  ws.emit("open");
  return { ws, adapter };
}

const HEARTBEAT_MS = 30_000;

describe("WsSocketAdapter — heartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pings on the heartbeat cadence and stays up while pongs come back", () => {
    const { ws } = makeAdapter();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(ws.pings).toBe(1);
    ws.emit("pong");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(ws.pings).toBe(2);
    expect(ws.terminated).toBe(0);
  });

  it("terminates a socket whose ping got no pong (silently dead path)", () => {
    const { ws } = makeAdapter();
    const closes: number[] = [];
    // Adapter consumers learn about the death via the ws 'close' event.
    ws.on("close", (code: number) => closes.push(code));
    vi.advanceTimersByTime(HEARTBEAT_MS); // ping 1 — never answered
    vi.advanceTimersByTime(HEARTBEAT_MS); // tick 2 — still awaiting → terminate
    expect(ws.terminated).toBe(1);
    expect(closes).toContain(1006);
    // No further pings after termination.
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(ws.pings).toBe(1);
  });

  it("a local close stops the heartbeat", () => {
    const { ws, adapter } = makeAdapter();
    adapter.close("client-stop");
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(ws.pings).toBe(0);
    expect(ws.terminated).toBe(0);
  });

  it("does not ping a socket that is no longer OPEN", () => {
    const { ws } = makeAdapter();
    ws.readyState = 3; // CLOSED (but no close event delivered — mid-teardown)
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(ws.pings).toBe(0);
  });
});

describe("WsSocketAdapter — a dial the broker never answers", () => {
  it("closing it mid-handshake fires close, so a stuck dial can be dropped and re-dialed", async () => {
    // The 2026-11-20 shape: the connection is accepted but the upgrade is never answered.
    // `ws` sets no handshake timeout, so only the dialer's join deadline ends this dial,
    // and it does that by closing the socket — which must reach the close handler.
    const held: Socket[] = [];
    let upgraded!: () => void;
    const reached = new Promise<void>((resolve) => { upgraded = resolve; });
    const server = createServer();
    server.on("upgrade", (_req, socket: Socket) => { held.push(socket); upgraded(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const adapter = openBrokerSocket(`ws://127.0.0.1:${port}/connect`, "tok");
      const closed = new Promise<number>((resolve) => adapter.onClose((code) => resolve(code)));
      await reached;
      adapter.close("client-stop");
      expect(await closed).toBe(1006);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("WsSocketAdapter — the broker still holds this socket", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** One heartbeat tick, the network path answering as it does. */
  function tick(ws: FakeWs): void {
    vi.advanceTimersByTime(HEARTBEAT_MS);
    ws.emit("pong");
  }

  it("sends the broker's ping on every heartbeat, beside the protocol ping", () => {
    const { ws } = makeAdapter();
    tick(ws);
    tick(ws);
    expect(ws.sent).toEqual([BROKER_PING, BROKER_PING]);
    expect(ws.pings).toBe(2);
  });

  it("takes the broker's pong itself and passes every other frame on", () => {
    const { ws, adapter } = makeAdapter();
    const frames: string[] = [];
    adapter.onMessage((text) => frames.push(text));
    ws.emit("message", Buffer.from(BROKER_PONG));
    ws.emit("message", Buffer.from('{"type":"peer-joined"}'));
    expect(frames).toEqual(['{"type":"peer-joined"}']);
  });

  it("drops a socket the broker answered before and has stopped answering, though the path is alive", () => {
    // The gap the join deadline cannot see: seated, then lost by the broker, while
    // the connection itself still answers protocol pings.
    const { ws, adapter } = makeAdapter();
    adapter.onMessage(() => {});
    const closes: number[] = [];
    adapter.onClose((code) => closes.push(code));
    tick(ws);
    ws.emit("message", Buffer.from(BROKER_PONG));
    tick(ws); // this ping goes unanswered by the broker
    expect(ws.terminated).toBe(0);
    tick(ws);
    expect(ws.terminated).toBe(1);
    expect(closes).toEqual([1006]);
  });

  it("never drops a socket over a broker that has not answered once", () => {
    const { ws, adapter } = makeAdapter();
    adapter.onMessage(() => {});
    for (let i = 0; i < 5; i++) tick(ws);
    expect(ws.terminated).toBe(0);
  });
});
