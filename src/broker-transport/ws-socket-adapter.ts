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
import { BrokerLiveness } from "./vendor/broker-liveness.js";
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
  /** Whether the broker still holds this socket, from its answers to our app-level ping. */
  private readonly liveness = new BrokerLiveness();
  /** When the socket reached OPEN, so a close can report how long it survived.
   *  0 means it never opened (dial refused) — a different failure than a drop. */
  private openedAt = 0;

  constructor(private readonly ws: WebSocket) {
    ws.on("open", () => {
      this.openedAt = Date.now();
      this.startHeartbeat();
    });
    ws.on("pong", () => {
      this.awaitingPong = false;
    });
    ws.on("close", () => this.stopHeartbeat());
  }

  /** Liveness, two checks on each HEARTBEAT_MS tick once open; either one unanswered from
   *  the previous tick terminates the socket so 'close' fires and the supervisor re-dials.
   *   - A protocol ping, answered by Cloudflare's runtime: proves the network path (the
   *     sleep/NAT death class).
   *   - The broker's app-level ping (BrokerLiveness), answered only for a socket the
   *     rendezvous Durable Object still holds: proves we are still in the room, which a
   *     protocol pong does not. It counts once the broker has answered one. */
  private startHeartbeat(): void {
    if (this.heartbeat !== null || this.closed) return;
    this.awaitingPong = false;
    this.heartbeat = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        this.terminate("no pong — terminating dead socket (slept/NAT-dropped path)");
        return;
      }
      const beat = this.liveness.beat();
      if (beat.kind === "lost") {
        this.terminate("the broker stopped answering — it no longer holds this socket; terminating to re-dial");
        return;
      }
      this.awaitingPong = true;
      try {
        this.ws.ping();
        this.ws.send(beat.frame);
      } catch {
        /* socket died mid-tick — the close event will drive teardown */
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private terminate(why: string): void {
    logger.warn(`[broker-transport] heartbeat: ${why}`);
    this.stopHeartbeat();
    this.ws.terminate(); // hard-close → 'close' fires → dialer teardown → re-dial
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
      const text = typeof data === "string" ? data : data.toString();
      // The broker's liveness pong is ours, not a ServerFrame for BrokerClient.
      if (this.liveness.take(text)) return;
      handler(text);
    });
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.ws.on("close", (code: number, reason: Buffer) => {
      this.closed = true;
      const text = reason.toString();
      // The code is the ONLY thing that distinguishes a broker-initiated hangup
      // (1001 going-away / DO eviction, 1011 internal, 1012 restart) from a path
      // death (1006, no close frame) — and BrokerClient discards it on the
      // non-auth branch. Log it here, at the one place that still has it.
      logger.info(
        `[broker-transport] socket closed after ${Math.round((Date.now() - this.openedAt) / 1000)}s: code=${code}${text ? ` reason=${text}` : ""}${this.openedAt === 0 ? " (never opened)" : ""}`,
      );
      handler(code, text);
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
