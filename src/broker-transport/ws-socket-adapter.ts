// The desktop's concrete SocketAdapter — wraps a Node `ws` WebSocket in the tiny
// seam BrokerClient consumes (vendor/socket-adapter.ts). BrokerClient is transport-
// agnostic; this is the one file that knows about `ws`.
//
// The desktop CAN set request headers (unlike a browser/RN WebSocket), so it dials
// with an `Authorization: Bearer` header and omits `?token=` from the URL — the
// broker reads either (worker.ts bearerCredential). Keeping the token out of the URL
// avoids it landing in any proxy/access log (the URL is logged far more than headers).

import WebSocket from "ws";
import type { CloseReason, SocketAdapter } from "./vendor/socket-adapter.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.ws");

/** Protocol-ping cadence. System sleep and NAT/Wi-Fi churn kill this socket SILENTLY —
 *  TCP keepalive offload keeps it LOOKING open, no close event ever fires, and the
 *  desktop holds a zombie presence the broker evicted hours ago (live incident
 *  2026-08-23: last dial 16:40, zombie until 22:00+). A missed pong terminates the
 *  socket so the real 'close' fires and the presence supervisor re-dials. */
const HEARTBEAT_MS = 30_000;

/** Open a `ws` WebSocket to the broker connect URL with a bearer header, wrapped in
 *  the SocketAdapter seam. The socket begins connecting immediately; BrokerClient
 *  registers its handlers synchronously in its constructor, before any frame can
 *  arrive, so no inbound message is missed. */
export function openBrokerSocket(connectUrl: string, token: string): SocketAdapter {
  const ws = new WebSocket(connectUrl, { headers: { Authorization: `Bearer ${token}` } });
  return new WsSocketAdapter(ws);
}

/** Adapts a `ws` WebSocket to the SocketAdapter contract. The caller has already
 *  begun opening the socket (openBrokerSocket above). */
export class WsSocketAdapter implements SocketAdapter {
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private awaitingPong = false;

  constructor(private readonly ws: WebSocket) {
    ws.on("open", () => this.startHeartbeat());
    ws.on("pong", () => {
      this.awaitingPong = false;
    });
    ws.on("close", () => this.stopHeartbeat());
  }

  /** Liveness: ping every HEARTBEAT_MS once open; a tick with the previous ping still
   *  unanswered means the path is dead even though the socket looks open — terminate
   *  so 'close' fires and the supervisor re-dials. Cloudflare answers protocol pings
   *  at the edge, so this proves the network path (the sleep/NAT death class), not DO
   *  health — which is fine: a dead DO surfaces as broker frames, not silence. */
  private startHeartbeat(): void {
    if (this.heartbeat !== null || this.closed) return;
    this.awaitingPong = false;
    this.heartbeat = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        logger.warn("[broker-transport] heartbeat: no pong — terminating dead socket (slept/NAT-dropped path)");
        this.stopHeartbeat();
        this.ws.terminate(); // hard-close → 'close' fires → dialer teardown → re-dial
        return;
      }
      this.awaitingPong = true;
      try {
        this.ws.ping();
      } catch {
        /* socket died mid-tick — the close event will drive teardown */
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  send(text: string): void {
    // Only OPEN sockets accept frames; before OPEN, BrokerClient hasn't been asked to
    // send anything (it sends only after `joined`/`peer-present`, which arrive post-
    // open). Guard anyway so a race during teardown is a no-op, not a throw.
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(text);
    } catch (e) {
      logger.warn(`[broker-transport] send failed: ${(e as Error).message}`);
    }
  }

  close(_reason: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    try {
      this.ws.close();
    } catch {
      /* already closing/closed */
    }
  }

  onMessage(handler: (data: string) => void): void {
    this.ws.on("message", (data: WebSocket.RawData) => {
      // The broker only ever sends text frames; coerce defensively so a Buffer/array
      // payload still parses (ws delivers Buffer unless told otherwise).
      handler(typeof data === "string" ? data : data.toString());
    });
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.ws.on("close", (code: number, reason: Buffer) => {
      this.closed = true;
      handler(code, reason.toString());
    });
    // A transport error (DNS, refused, TLS) without a clean close still has to wake
    // BrokerClient so the UI never hangs. `ws` always fires "close" AFTER "error", so
    // we surface the error via the log here and let the following close drive the
    // machine (close carries the code BrokerClient maps to a terminal state).
    this.ws.on("error", (err: Error) => {
      logger.warn(`[broker-transport] socket error: ${err.message}`);
    });
  }
}
