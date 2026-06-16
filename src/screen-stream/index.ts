// Live-screen feature entry point for the chat-ws router.
//
// The chat-ws connection handler attaches one ScreenSession per DEVICE socket
// (operator/loopback connections don't get a live-screen session — the feature
// is bridge/device gated, matching the rest of the mobile surface). Inbound
// rtc_* frames are routed here; the WS close fires teardown. Outbound signaling
// frames go back over the SAME socket as JSON (so they ride the authenticated
// /ws/chat, never a new endpoint — constitution §8).

import type { WebSocket } from "ws";
import { ScreenSession } from "./session.js";
import { parseRtcInbound, isRtcFrameType, type RtcOutboundFrame } from "./protocol.js";
import { createLogger } from "../logger.js";

const logger = createLogger("screen-stream");

/** Per-WS live-screen attachment. One session; tears down on socket close. */
export interface ScreenAttachment {
  /** Route a parsed chat-ws message; returns true if it was an rtc_* frame. */
  handleMessage(msg: Record<string, unknown>): boolean;
}

/**
 * Attach a live-screen session to a device WebSocket. Returns an attachment whose
 * handleMessage() the router calls for every inbound frame; rtc_* frames are
 * consumed, everything else is passed through (returns false).
 */
export function attachScreenStream(ws: WebSocket): ScreenAttachment {
  const send = (frame: RtcOutboundFrame): void => {
    try {
      ws.send(JSON.stringify(frame));
    } catch (e) {
      logger.warn(`[screen-stream] send failed: ${(e as Error).message}`);
    }
  };

  const session = new ScreenSession({ send });

  // Socket close (incl. device revoke via closeDeviceSockets) ⇒ stop capture +
  // peer immediately. Never a lingering ffmpeg or half-open peer (constitution §7).
  ws.on("close", () => session.handleDisconnect());

  return {
    handleMessage(msg: Record<string, unknown>): boolean {
      if (!isRtcFrameType(msg.type)) return false;
      const frame = parseRtcInbound(msg);
      if (frame === null) {
        logger.warn(`[screen-stream] dropped malformed ${String(msg.type)} frame`);
        return true; // it WAS an rtc_* type; we claim + drop it (don't pass through)
      }
      session.handleFrame(frame);
      return true;
    },
  };
}

export { ScreenSession } from "./session.js";
export type { ScreenSessionOptions, SendFrame } from "./session.js";
export {
  signalingReducer,
  initialSignaling,
  type SignalingState,
  type SignalingAction,
  type SignalingEffect,
  type SignalingMachine,
  type SignalingTransition,
} from "./signaling-machine.js";
export {
  parseRtcInbound,
  isRtcFrameType,
  buildOffer,
  buildIce,
  buildError,
  buildClosed,
  RTC_FRAME_TYPES,
} from "./protocol.js";
export type {
  RtcInboundFrame,
  RtcOutboundFrame,
  RtcSdp,
  RtcIceCandidate,
} from "./protocol.js";
