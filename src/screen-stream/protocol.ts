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

/** One remote-control action the phone drives. Coordinates are NORMALIZED to the
 *  captured screen (0..1) so the phone never needs the desktop's pixel size — the
 *  desktop scales by the live monitor's dimensions. `move` is absolute (direct-
 *  touch); `moveBy` is a relative nudge (trackpad). `down`/`up` bracket a drag. */
export type ScreenInputEvent =
  | { kind: "move"; x: number; y: number }
  | { kind: "moveBy"; dx: number; dy: number }
  | { kind: "click"; button?: "left" | "right"; double?: boolean }
  | { kind: "down"; button?: "left" | "right" }
  | { kind: "up"; button?: "left" | "right" }
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "key"; keys: string[] };

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

/** Desktop reports how many monitors exist, which is live, and the live monitor's
 *  pixel size. count drives swipe-between-screens; width/height let the phone
 *  letterbox-correct so direct-touch maps to the right desktop point. */
export interface RtcDisplaysFrame {
  type: "rtc_displays";
  rtcId: string;
  count: number;
  active: number;
  width: number;
  height: number;
}

/** Every signaling frame the phone sends (desktop receives + routes). */
export type RtcInboundFrame = RtcStartFrame | RtcAnswerFrame | RtcIceFrame | RtcStopFrame | RtcInputFrame;

/** Every signaling frame the desktop sends back to the phone. */
export type RtcOutboundFrame =
  | RtcOfferFrame
  | RtcDesktopIceFrame
  | RtcErrorFrame
  | RtcClosedFrame
  | RtcDisplaysFrame;

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

export function buildError(rtcId: string, message: string): RtcErrorFrame {
  return { type: "rtc_error", rtcId, message };
}

export function buildClosed(rtcId: string, reason: string): RtcClosedFrame {
  return { type: "rtc_closed", rtcId, reason };
}

export function buildDisplays(
  rtcId: string,
  count: number,
  active: number,
  width: number,
  height: number,
): RtcDisplaysFrame {
  return { type: "rtc_displays", rtcId, count, active, width, height };
}

/** Validate an untrusted input-event payload from the phone. Returns null for
 *  anything malformed so the session drops it instead of injecting garbage. */
export function parseScreenInputEvent(raw: unknown): ScreenInputEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const button = e.button === "right" ? "right" : "left";
  switch (e.kind) {
    case "move":
      return num(e.x) && num(e.y) ? { kind: "move", x: e.x, y: e.y } : null;
    case "moveBy":
      return num(e.dx) && num(e.dy) ? { kind: "moveBy", dx: e.dx, dy: e.dy } : null;
    case "click":
      return { kind: "click", button, double: e.double === true };
    case "down":
      return { kind: "down", button };
    case "up":
      return { kind: "up", button };
    case "scroll":
      return num(e.dx) && num(e.dy) ? { kind: "scroll", dx: e.dx, dy: e.dy } : null;
    case "text":
      return typeof e.text === "string" && e.text.length > 0 ? { kind: "text", text: e.text } : null;
    case "key":
      return Array.isArray(e.keys) && e.keys.every((k) => typeof k === "string") && e.keys.length > 0
        ? { kind: "key", keys: e.keys as string[] }
        : null;
    default:
      return null;
  }
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
