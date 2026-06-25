// The app-control seam for the broker transport.
//
// WHY THIS EXISTS: the broker is a PURE signaling introducer (constitution §9) — it
// relays only offer/answer/ICE and refuses everything else. But live-screen also
// exchanges APP CONTROL — remote input (phone → desktop) and display/focus/error
// notices (desktop → phone). Over the tailnet those rode the same /ws/chat socket;
// off the tailnet their correct home is the WebRTC DATA CHANNEL (already E2E, no third
// party) — see docs/integration-lax-mobile.md §3.4.
//
// The data channel is owned by the peer (ScreenPeer), which surfaces a ControlTransport
// once it opens. This seam lets the dialer route control without knowing about the
// data channel directly: DataChannelControl.attach(transport) connects the two when
// the peer is ready. NullControlChannel is the inert fallback (view-only).

import type { ControlTransport } from "../screen-stream/peer.js";
import { parseScreenInputEvent } from "../screen-stream/protocol.js";
import type { RtcOutboundFrame, ScreenInputEvent } from "../screen-stream/protocol.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.control");

/** The desktop → phone control frames (everything the session emits that is NOT
 *  WebRTC signaling). Offer/ICE are signaling and go to the broker; these do not. */
export type ControlOutbound = Extract<
  RtcOutboundFrame,
  { type: "rtc_displays" } | { type: "rtc_focus" } | { type: "rtc_error" } | { type: "rtc_closed" }
>;

/** Carries app control between the paired peers, out of band from broker signaling.
 *  The real implementation (DataChannelControl) rides the WebRTC data channel; this
 *  seam keeps the dialer from depending on it directly. */
export interface ControlChannel {
  /** Send one outbound control frame to the phone (displays/focus/error/closed). */
  send(frame: ControlOutbound): void;
  /** Register the inbound handler — remote input the phone drives. Called once. */
  onInput(handler: (event: ScreenInputEvent) => void): void;
  /** Connect the underlying transport once the peer's data channel is open. The peer
   *  surfaces the ControlTransport asynchronously (post-negotiation), so the dialer
   *  may have buffered outbound control before this fires. */
  attach(transport: ControlTransport): void;
  /** Tear the channel down with the session. Idempotent. */
  close(): void;
}

/**
 * The real control channel: serializes outbound control frames as JSON over the
 * WebRTC data channel and parses inbound remote-input frames back out. Outbound sends
 * that arrive before the channel opens are BUFFERED and flushed on attach, so a
 * display/focus hint emitted during negotiation isn't lost.
 */
export class DataChannelControl implements ControlChannel {
  private transport: ControlTransport | null = null;
  private inputHandler: ((event: ScreenInputEvent) => void) | null = null;
  private readonly outboundQueue: ControlOutbound[] = [];
  private closed = false;

  send(frame: ControlOutbound): void {
    if (this.closed) return;
    if (this.transport) this.transport.send(JSON.stringify(frame));
    else this.outboundQueue.push(frame); // buffer until the data channel opens
  }

  onInput(handler: (event: ScreenInputEvent) => void): void {
    this.inputHandler = handler;
  }

  attach(transport: ControlTransport): void {
    if (this.closed) return;
    this.transport = transport;
    transport.onMessage((text) => this.handleInbound(text));
    transport.onClose(() => {
      this.transport = null;
    });
    for (const frame of this.outboundQueue) transport.send(JSON.stringify(frame));
    this.outboundQueue.length = 0;
  }

  close(): void {
    this.closed = true;
    this.transport = null;
    this.outboundQueue.length = 0;
  }

  /** Parse one inbound data-channel message. The phone sends the same rtc_input frame
   *  it used over /ws/chat; we validate the event with the existing parser (one source
   *  of truth) and drop anything else — never inject an unvalidated event. */
  private handleInbound(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return; // non-JSON noise on the channel — ignore
    }
    if (!raw || typeof raw !== "object") return;
    const msg = raw as Record<string, unknown>;
    if (msg.type !== "rtc_input") return; // the desktop only consumes input over the dc
    const event = parseScreenInputEvent(msg.event);
    if (event && this.inputHandler) this.inputHandler(event);
  }
}

/**
 * No-op ControlChannel: makes the broker transport work VIEW-ONLY (no data channel).
 * Outbound control is dropped; inbound input never arrives. Warns ONCE so a tester
 * knows control is inert by design, not silently broken (constitution §16).
 */
export class NullControlChannel implements ControlChannel {
  private warned = false;

  send(frame: ControlOutbound): void {
    if (!this.warned) {
      this.warned = true;
      logger.warn(
        "[broker-transport] control channel not wired — live screen is VIEW-ONLY " +
          `(remote input + display/focus hints are inert). Dropping ${frame.type}.`,
      );
    }
  }

  onInput(_handler: (event: ScreenInputEvent) => void): void {
    /* no inbound path — remote control is inert */
  }

  attach(_transport: ControlTransport): void {
    /* nothing to wire — view-only */
  }

  close(): void {
    /* nothing to tear down */
  }
}
