// The live-screen session's signaling vocabulary on the desktop.
//
// The rtc_start / rtc_answer / rtc_offer / rtc_ice / rtc_stop frames are this side's
// own. Over the broker, broker-transport/broker-screen-dialer.ts translates them to and
// from the broker's signals; only a device socket on /ws/chat (index.ts) carries them
// as written. What reaches the phone over the broker peer, the remote-input event and
// the display, focus, error and closed frames on the control channel, is the shared
// agentxos contract (broker-transport/vendor/control.ts), re-exported here.
//
//   phone → desktop:  rtc_start, rtc_answer{sdp}, rtc_ice{candidate}, rtc_stop
//   desktop → phone:  rtc_offer{sdp},  rtc_ice{candidate}, rtc_error{message}, rtc_closed{reason}

import type {
  RtcClosedFrame,
  RtcDisplaysFrame,
  RtcErrorFrame,
  RtcFocusFrame,
  ScreenInputEvent,
} from "../broker-transport/vendor/protocol.js";
import { parseScreenInputEvent } from "../broker-transport/vendor/protocol.js";

export { buildClosed, buildDisplays, buildError, buildFocus, parseScreenInputEvent } from "../broker-transport/vendor/protocol.js";
export type { RtcClosedFrame, RtcDisplaysFrame, RtcErrorFrame, RtcFocusFrame, ScreenInputEvent };

/** Minimal SDP description shape exchanged in offer/answer (RTCSessionDescription subset). */
export interface RtcSdp {
  type: "offer" | "answer";
  sdp: string;
}

/** Minimal ICE candidate shape exchanged trickle-style (RTCIceCandidateInit subset). */
export interface RtcIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

// ── phone → desktop ──

/** Phone asks the desktop to begin a live-screen session (capture + offer). */
export interface RtcStartFrame {
  type: "rtc_start";
  /** Correlates all frames for one session; minted by the phone. */
  rtcId: string;
  /** Optional monitor index to capture (desktop defaults to primary). */
  monitor?: number;
}

/** Phone's SDP answer to the desktop's offer. */
export interface RtcAnswerFrame {
  type: "rtc_answer";
  rtcId: string;
  sdp: string;
}

/** A trickled ICE candidate from the phone. */
export interface RtcIceFrame {
  type: "rtc_ice";
  rtcId: string;
  candidate: RtcIceCandidate;
}

/** Phone tears the session down (closed live view / backgrounded). */
export interface RtcStopFrame {
  type: "rtc_stop";
  rtcId: string;
}

/** Phone drives the desktop mouse/keyboard. Gated by enableRemoteControl AND the
 *  OS input grant on the desktop side — never trusted blindly here. */
export interface RtcInputFrame {
  type: "rtc_input";
  rtcId: string;
  event: ScreenInputEvent;
}

// ── desktop → phone ──

/** Desktop's SDP offer (it created the peer + added the screen track). */
export interface RtcOfferFrame {
  type: "rtc_offer";
  rtcId: string;
  sdp: string;
}

/** A trickled ICE candidate from the desktop. */
export interface RtcDesktopIceFrame {
  type: "rtc_ice";
  rtcId: string;
  candidate: RtcIceCandidate;
}

/** Every signaling frame the phone sends (desktop receives + routes). */
export type RtcInboundFrame = RtcStartFrame | RtcAnswerFrame | RtcIceFrame | RtcStopFrame | RtcInputFrame;

/** Every signaling frame the desktop sends back to the phone. */
export type RtcOutboundFrame =
  | RtcOfferFrame
  | RtcDesktopIceFrame
  | RtcErrorFrame
  | RtcClosedFrame
  | RtcDisplaysFrame
  | RtcFocusFrame;

/** All rtc_* type tags — used to claim a frame at the chat-ws router. */
export const RTC_FRAME_TYPES = [
  "rtc_start",
  "rtc_answer",
  "rtc_ice",
  "rtc_stop",
  "rtc_input",
] as const;

/** True when a parsed chat-ws message is an rtc_* signaling frame. */
export function isRtcFrameType(type: unknown): type is RtcInboundFrame["type"] {
  return typeof type === "string" && (RTC_FRAME_TYPES as readonly string[]).includes(type);
}

// ── frame builders (desktop → phone) — single construction point, unit-tested ──

export function buildOffer(rtcId: string, sdp: string): RtcOfferFrame {
  return { type: "rtc_offer", rtcId, sdp };
}

export function buildIce(rtcId: string, candidate: RtcIceCandidate): RtcDesktopIceFrame {
  return { type: "rtc_ice", rtcId, candidate };
}

/** Parse + validate an inbound frame; returns null for anything malformed so the
 *  router drops it instead of throwing (mirrors chat parseFrame discipline). */
export function parseRtcInbound(msg: Record<string, unknown>): RtcInboundFrame | null {
  const type = msg.type;
  const rtcId = msg.rtcId;
  if (typeof type !== "string" || typeof rtcId !== "string" || rtcId.length === 0) return null;
  switch (type) {
    case "rtc_start": {
      const monitor = typeof msg.monitor === "number" ? msg.monitor : undefined;
      return monitor === undefined
        ? { type, rtcId }
        : { type, rtcId, monitor };
    }
    case "rtc_stop":
      return { type, rtcId };
    case "rtc_input": {
      const event = parseScreenInputEvent(msg.event);
      return event ? { type, rtcId, event } : null;
    }
    case "rtc_answer":
      return typeof msg.sdp === "string" ? { type, rtcId, sdp: msg.sdp } : null;
    case "rtc_ice": {
      const cand = msg.candidate;
      if (!cand || typeof cand !== "object") return null;
      const c = cand as Record<string, unknown>;
      if (typeof c.candidate !== "string") return null;
      return {
        type,
        rtcId,
        candidate: {
          candidate: c.candidate,
          sdpMid: typeof c.sdpMid === "string" ? c.sdpMid : null,
          sdpMLineIndex: typeof c.sdpMLineIndex === "number" ? c.sdpMLineIndex : null,
        },
      };
    }
    default:
      return null;
  }
}
