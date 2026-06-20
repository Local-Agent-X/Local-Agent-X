// Signaling frame builder + parser tests (deliverable §3). The builders are the
// single construction point for outbound (desktop→phone) frames; parseRtcInbound
// validates phone→desktop frames and drops malformed ones (router robustness).

import { describe, it, expect } from "vitest";
import {
  buildOffer,
  buildIce,
  buildError,
  buildClosed,
  buildDisplays,
  parseRtcInbound,
  parseScreenInputEvent,
  isRtcFrameType,
} from "./protocol.js";

describe("outbound frame builders", () => {
  it("buildOffer produces an rtc_offer with the rtcId + sdp", () => {
    expect(buildOffer("r1", "v=0...")).toEqual({ type: "rtc_offer", rtcId: "r1", sdp: "v=0..." });
  });

  it("buildIce wraps the candidate", () => {
    const cand = { candidate: "candidate:1 1 udp ...", sdpMid: "0", sdpMLineIndex: 0 };
    expect(buildIce("r1", cand)).toEqual({ type: "rtc_ice", rtcId: "r1", candidate: cand });
  });

  it("buildError + buildClosed carry actionable text", () => {
    expect(buildError("r1", "ffmpeg missing")).toEqual({ type: "rtc_error", rtcId: "r1", message: "ffmpeg missing" });
    expect(buildClosed("r1", "Stopped by user.")).toEqual({ type: "rtc_closed", rtcId: "r1", reason: "Stopped by user." });
  });
});

describe("remote-control frames", () => {
  it("buildDisplays reports monitor count, active index + live size", () => {
    expect(buildDisplays("r1", 2, 0, 2560, 1440)).toEqual({
      type: "rtc_displays",
      rtcId: "r1",
      count: 2,
      active: 0,
      width: 2560,
      height: 1440,
    });
  });

  it("parses a valid rtc_input frame, defaulting button to left", () => {
    const frame = parseRtcInbound({ type: "rtc_input", rtcId: "r1", event: { kind: "click" } });
    expect(frame).toEqual({ type: "rtc_input", rtcId: "r1", event: { kind: "click", button: "left", double: false } });
  });

  it("claims rtc_input as an inbound type", () => {
    expect(isRtcFrameType("rtc_input")).toBe(true);
  });

  it("validates move/moveBy/scroll coords are finite numbers", () => {
    expect(parseScreenInputEvent({ kind: "move", x: 0.5, y: 0.25 })).toEqual({ kind: "move", x: 0.5, y: 0.25 });
    expect(parseScreenInputEvent({ kind: "move", x: "0.5", y: 1 })).toBeNull();
    expect(parseScreenInputEvent({ kind: "moveBy", dx: 0.1, dy: NaN })).toBeNull();
    expect(parseScreenInputEvent({ kind: "scroll", dx: 0, dy: 3 })).toEqual({ kind: "scroll", dx: 0, dy: 3 });
  });

  it("accepts text + key chords, rejects empties", () => {
    expect(parseScreenInputEvent({ kind: "text", text: "hi" })).toEqual({ kind: "text", text: "hi" });
    expect(parseScreenInputEvent({ kind: "text", text: "" })).toBeNull();
    expect(parseScreenInputEvent({ kind: "key", keys: ["cmd", "c"] })).toEqual({ kind: "key", keys: ["cmd", "c"] });
    expect(parseScreenInputEvent({ kind: "key", keys: [] })).toBeNull();
    expect(parseScreenInputEvent({ kind: "bogus" })).toBeNull();
  });

  it("maps right-button + double-click flags through", () => {
    expect(parseScreenInputEvent({ kind: "click", button: "right" })).toEqual({ kind: "click", button: "right", double: false });
    expect(parseScreenInputEvent({ kind: "click", double: true })).toEqual({ kind: "click", button: "left", double: true });
  });
});

describe("isRtcFrameType", () => {
  it("claims rtc_* inbound types only", () => {
    expect(isRtcFrameType("rtc_start")).toBe(true);
    expect(isRtcFrameType("rtc_answer")).toBe(true);
    expect(isRtcFrameType("rtc_ice")).toBe(true);
    expect(isRtcFrameType("rtc_stop")).toBe(true);
    expect(isRtcFrameType("chat")).toBe(false);
    expect(isRtcFrameType("rtc_offer")).toBe(false); // outbound — not a router-claimed inbound
    expect(isRtcFrameType(undefined)).toBe(false);
  });
});

describe("parseRtcInbound", () => {
  it("parses rtc_start (with + without monitor)", () => {
    expect(parseRtcInbound({ type: "rtc_start", rtcId: "r1" })).toEqual({ type: "rtc_start", rtcId: "r1" });
    expect(parseRtcInbound({ type: "rtc_start", rtcId: "r1", monitor: 1 })).toEqual({
      type: "rtc_start",
      rtcId: "r1",
      monitor: 1,
    });
  });

  it("parses rtc_answer with an sdp string", () => {
    expect(parseRtcInbound({ type: "rtc_answer", rtcId: "r1", sdp: "v=0" })).toEqual({
      type: "rtc_answer",
      rtcId: "r1",
      sdp: "v=0",
    });
  });

  it("normalizes an rtc_ice candidate (missing sdpMid/index → null)", () => {
    const parsed = parseRtcInbound({ type: "rtc_ice", rtcId: "r1", candidate: { candidate: "cand:1" } });
    expect(parsed).toEqual({
      type: "rtc_ice",
      rtcId: "r1",
      candidate: { candidate: "cand:1", sdpMid: null, sdpMLineIndex: null },
    });
  });

  it("parses rtc_stop", () => {
    expect(parseRtcInbound({ type: "rtc_stop", rtcId: "r1" })).toEqual({ type: "rtc_stop", rtcId: "r1" });
  });

  it("drops frames missing rtcId", () => {
    expect(parseRtcInbound({ type: "rtc_start" })).toBeNull();
    expect(parseRtcInbound({ type: "rtc_answer", rtcId: "", sdp: "v=0" })).toBeNull();
  });

  it("drops an rtc_answer with no sdp", () => {
    expect(parseRtcInbound({ type: "rtc_answer", rtcId: "r1" })).toBeNull();
  });

  it("drops an rtc_ice with no candidate string", () => {
    expect(parseRtcInbound({ type: "rtc_ice", rtcId: "r1", candidate: {} })).toBeNull();
    expect(parseRtcInbound({ type: "rtc_ice", rtcId: "r1" })).toBeNull();
  });

  it("drops an unknown type", () => {
    expect(parseRtcInbound({ type: "rtc_bogus", rtcId: "r1" })).toBeNull();
  });
});
