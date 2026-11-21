// BrokerLiveness — whether the broker still holds this device's socket, judged from
// BROKER_PING / BROKER_PONG (protocol package, "BROKER LIVENESS"). Pure: the host's
// socket adapter owns the timer and the socket. On each heartbeat tick it calls beat()
// and sends the ping, or drops the socket and re-dials when beat() says the broker is
// gone; it offers every inbound text frame to take() first, before BrokerClient parses
// it, because a pong is not a ServerFrame.
//
// The rule bites only once this socket has had a pong. Until then a missing pong proves
// nothing — the dial itself is covered by the host's join deadline — so a socket only
// drops for silence from a broker that has already shown it answers. Shared by the
// desktop and the phone: the phone has no other liveness check (React Native's
// WebSocket cannot send a protocol ping).

import { BROKER_PING, BROKER_PONG } from "./protocol.js";

export type LivenessBeat = { kind: "ping"; frame: string } | { kind: "lost" };

export class BrokerLiveness {
  /** The broker has answered a ping on this socket. */
  private answers = false;
  /** A ping is out with no pong yet. */
  private awaiting = false;

  /** One heartbeat tick: `lost` when the broker answered before and has not answered the
   *  previous ping; otherwise the ping to send now. */
  beat(): LivenessBeat {
    if (this.answers && this.awaiting) return { kind: "lost" };
    this.awaiting = true;
    return { kind: "ping", frame: BROKER_PING };
  }

  /** Offer an inbound text frame. True when it was the broker's pong, which the caller
   *  consumes instead of passing it on as a ServerFrame. */
  take(text: string): boolean {
    if (text !== BROKER_PONG) return false;
    this.answers = true;
    this.awaiting = false;
    return true;
  }
}
