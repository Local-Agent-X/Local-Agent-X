// Signaling frame builder + parser tests (deliverable §3). The builders are the
// single construction point for outbound (desktop→phone) frames; parseRtcInbound
// validates phone→desktop frames and drops malformed ones (router robustness).

import { describe, it, expect } from "vitest";
import {
  buildOffer,
  buildIce,
  buildError,
  buildClosed,
  parseRtcInbound,
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
