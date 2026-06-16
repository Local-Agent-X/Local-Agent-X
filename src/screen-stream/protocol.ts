// WebRTC signaling protocol for the live-screen feature (product flow 6).
//
// These frames ride the EXISTING authenticated /ws/chat socket (architecture:
// "signaling over /ws/chat"); they are NOT a new endpoint. The chat upgrade gate
// already device-token / operator gates the connection, so signaling inherits
// that auth — no parallel auth surface (constitution §8).
//
// The mobile app mirrors these exact shapes in app/src/screen/protocol.ts. Keep
// the two in sync: the desktop is the OFFERER (it owns the screen), the phone is
// the ANSWERER (it consumes the track).
//
// Wire direction:
//   phone → desktop:  rtc_start, rtc_answer{sdp}, rtc_ice{candidate}, rtc_stop
//   desktop → phone:  rtc_offer{sdp},  rtc_ice{candidate}, rtc_error{message}, rtc_closed{reason}
//
// Transport note: both peers are on the Tailscale tailnet, so host ICE candidates
// over the tailnet interface connect directly. STUN is OPTIONAL (only needed if a
// peer can't see its own tailnet address); no TURN relay is required for the
// prototype — there is no NAT to traverse on the tailnet (constitution §6).

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

/** A session error the phone surfaces as an actionable message (constitution §12). */
export interface RtcErrorFrame {
  type: "rtc_error";
  rtcId: string;
  message: string;
}

/** Desktop closed the session (stop / disconnect / revoke) — never a silent hang. */
export interface RtcClosedFrame {
  type: "rtc_closed";
  rtcId: string;
  reason: string;
}

/** Every signaling frame the phone sends (desktop receives + routes). */
export type RtcInboundFrame = RtcStartFrame | RtcAnswerFrame | RtcIceFrame | RtcStopFrame;

/** Every signaling frame the desktop sends back to the phone. */
export type RtcOutboundFrame =
  | RtcOfferFrame
  | RtcDesktopIceFrame
  | RtcErrorFrame
  | RtcClosedFrame;

/** All rtc_* type tags — used to claim a frame at the chat-ws router. */
export const RTC_FRAME_TYPES = [
  "rtc_start",
  "rtc_answer",
  "rtc_ice",
  "rtc_stop",
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

export function buildError(rtcId: string, message: string): RtcErrorFrame {
  return { type: "rtc_error", rtcId, message };
}

export function buildClosed(rtcId: string, reason: string): RtcClosedFrame {
  return { type: "rtc_closed", rtcId, reason };
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
