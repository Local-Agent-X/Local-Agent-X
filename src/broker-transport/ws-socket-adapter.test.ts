// WsSocketAdapter heartbeat tests — a fake `ws` WebSocket + fake timers prove the
// liveness ping: a pong keeps the socket, a missed pong terminates it (so 'close'
// fires and the presence supervisor re-dials). This is the guard against the
// silent-death class: system sleep / NAT drops kill the socket with NO close event
// (2026-08-23 live incident: a 6-hour zombie presence).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { WsSocketAdapter } from "./ws-socket-adapter.js";
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
  send(): void {
    /* unused */
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
