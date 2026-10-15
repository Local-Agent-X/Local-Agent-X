// Live-screen control, carried on the `control` data channel (link.ts). The video
// itself is a media track on the same peer; these frames are everything else.
//
//   phone → desktop:  rtc_input{event}, screen_open{monitor?}, screen_close
//   desktop → phone:  rtc_displays, rtc_focus, rtc_error, rtc_closed
//
// The broker gives each peer its own session id, so the `rtcId` on a desktop frame is
// the desktop's id, not the phone's. The receiver stamps its own (parseDesktopControl).

import { asNumber, asRecord, asString } from "./guards.js";

/** One remote-control action. Coordinates are normalized to the captured screen
 *  (0..1), so the phone never needs the desktop's pixel size. `move` is absolute
 *  (direct touch), `moveBy` a relative nudge (trackpad); `down`/`up` bracket a drag. */
export type ScreenInputEvent =
  | { kind: "move"; x: number; y: number }
  | { kind: "moveBy"; dx: number; dy: number }
  | { kind: "click"; button?: "left" | "right"; double?: boolean }
  | { kind: "down"; button?: "left" | "right" }
  | { kind: "up"; button?: "left" | "right" }
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "key"; keys: string[] };

// ── phone → desktop ──

/** Drive the desktop's mouse/keyboard. The desktop gates it on its own remote-control
 *  setting and the OS input grant. The channel is the session, so no rtcId. */
export type RtcInputFrame = { type: "rtc_input"; event: ScreenInputEvent };
/** Start capture on the persistent peer (the phone opened the live view). */
export type ScreenOpenFrame = { type: "screen_open"; monitor?: number };
/** Stop capture (the phone closed the live view). */
export type ScreenCloseFrame = { type: "screen_close" };

export type PhoneControlFrame = RtcInputFrame | ScreenOpenFrame | ScreenCloseFrame;

// ── desktop → phone ──

/** How many monitors exist, which is live, and the live monitor's pixel size (so the
 *  phone can letterbox-correct direct touch). */
export type RtcDisplaysFrame = {
  type: "rtc_displays";
  rtcId: string;
  count: number;
  active: number;
  width: number;
  height: number;
};
/** Whether a text-editable element has focus, so the phone can raise its keyboard. */
export type RtcFocusFrame = { type: "rtc_focus"; rtcId: string; editable: boolean };
/** An actionable session error for the phone to show. */
export type RtcErrorFrame = { type: "rtc_error"; rtcId: string; message: string };
/** The desktop ended the session (stop, disconnect or revoke). */
export type RtcClosedFrame = { type: "rtc_closed"; rtcId: string; reason: string };

export type DesktopControlFrame = RtcDisplaysFrame | RtcFocusFrame | RtcErrorFrame | RtcClosedFrame;

// ── builders: the one construction point for each frame ──

export function buildInput(event: ScreenInputEvent): RtcInputFrame {
  return { type: "rtc_input", event };
}

export function buildScreenOpen(monitor?: number): ScreenOpenFrame {
  return monitor === undefined ? { type: "screen_open" } : { type: "screen_open", monitor };
}

export function buildScreenClose(): ScreenCloseFrame {
  return { type: "screen_close" };
}

export function buildDisplays(rtcId: string, count: number, active: number, width: number, height: number): RtcDisplaysFrame {
  return { type: "rtc_displays", rtcId, count, active, width, height };
}

export function buildFocus(rtcId: string, editable: boolean): RtcFocusFrame {
  return { type: "rtc_focus", rtcId, editable };
}

export function buildError(rtcId: string, message: string): RtcErrorFrame {
  return { type: "rtc_error", rtcId, message };
}

export function buildClosed(rtcId: string, reason: string): RtcClosedFrame {
  return { type: "rtc_closed", rtcId, reason };
}

// ── parsers: null for anything malformed, so the receiver drops it ──

/** Validate an untrusted input event; never inject a malformed one. */
export function parseScreenInputEvent(raw: unknown): ScreenInputEvent | null {
  const e = asRecord(raw);
  if (e === null) return null;
  const button = e.button === "right" ? "right" : "left";
  switch (e.kind) {
    case "move": {
      const x = asNumber(e.x);
      const y = asNumber(e.y);
      return x !== null && y !== null ? { kind: "move", x, y } : null;
    }
    case "moveBy":
    case "scroll": {
      const dx = asNumber(e.dx);
      const dy = asNumber(e.dy);
      if (dx === null || dy === null) return null;
      return e.kind === "moveBy" ? { kind: "moveBy", dx, dy } : { kind: "scroll", dx, dy };
    }
    case "click":
      return { kind: "click", button, double: e.double === true };
    case "down":
      return { kind: "down", button };
    case "up":
      return { kind: "up", button };
    case "text":
      return typeof e.text === "string" && e.text.length > 0 ? { kind: "text", text: e.text } : null;
    case "key":
      return Array.isArray(e.keys) && e.keys.length > 0 && e.keys.every((k) => typeof k === "string")
        ? { kind: "key", keys: e.keys as string[] }
        : null;
    default:
      return null;
  }
}

/** A control frame from the phone, as the desktop reads it. */
export function parsePhoneControl(raw: unknown): PhoneControlFrame | null {
  const msg = asRecord(raw);
  if (msg === null) return null;
  switch (msg.type) {
    case "rtc_input": {
      const event = parseScreenInputEvent(msg.event);
      return event === null ? null : { type: "rtc_input", event };
    }
    case "screen_open":
      return buildScreenOpen(asNumber(msg.monitor) ?? undefined);
    case "screen_close":
      return buildScreenClose();
    default:
      return null;
  }
}

/** A control frame from the desktop, stamped with the RECEIVER's `rtcId` (the sender's
 *  is its own per-peer id and means nothing to the phone). */
export function parseDesktopControl(raw: unknown, rtcId: string): DesktopControlFrame | null {
  const msg = asRecord(raw);
  if (msg === null) return null;
  switch (msg.type) {
    case "rtc_displays": {
      const count = asNumber(msg.count);
      const active = asNumber(msg.active);
      const width = asNumber(msg.width);
      const height = asNumber(msg.height);
      return count !== null && active !== null && width !== null && height !== null
        ? buildDisplays(rtcId, count, active, width, height)
        : null;
    }
    case "rtc_focus":
      return typeof msg.editable === "boolean" ? buildFocus(rtcId, msg.editable) : null;
    case "rtc_error": {
      const message = asString(msg.message);
      return message === null ? null : buildError(rtcId, message);
    }
    case "rtc_closed": {
      const reason = asString(msg.reason);
      return reason === null ? null : buildClosed(rtcId, reason);
    }
    default:
      return null;
  }
}
