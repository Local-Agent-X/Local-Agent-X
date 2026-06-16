// Desktop signaling state-machine tests (deliverable §3): the offer→answer→ice→
// live ordering, that stray frames are ignored, and that stop/disconnect/fail
// always tear down. Pure folds — no ffmpeg, no werift, no socket.

import { describe, it, expect } from "vitest";
import {
  signalingReducer,
  initialSignaling,
  type SignalingAction,
  type SignalingEffect,
  type SignalingMachine,
} from "./signaling-machine.js";

const RTC = "rtc-1";

interface RunResult {
  state: SignalingMachine;
  effects: SignalingEffect[];
  /** All effects emitted across the whole run (ordering assertions). */
  allEffects: SignalingEffect[];
}

function run(actions: SignalingAction[], start: SignalingMachine = initialSignaling): RunResult {
  let state = start;
  let effects: SignalingEffect[] = [];
  const allEffects: SignalingEffect[] = [];
  for (const action of actions) {
    const t = signalingReducer(state, action);
    state = t.state;
    effects = t.effects;
    allEffects.push(...t.effects);
  }
  return { state, effects, allEffects };
}

/** Drive the happy path up to (and including) `live`. */
function liveSession(): SignalingMachine {
  return run([
    { kind: "start", rtcId: RTC },
    { kind: "offerReady", rtcId: RTC, sdp: "v=0 offer" },
    { kind: "answer", rtcId: RTC, sdp: "v=0 answer" },
    { kind: "remoteIce", rtcId: RTC },
    { kind: "peerState", rtcId: RTC, connection: "connected" },
  ]).state;
}

describe("signalingReducer — happy path ordering (offer→answer→ice→live)", () => {
  it("start → offering AND emits startCapture", () => {
    const { state, effects } = run([{ kind: "start", rtcId: RTC }]);
    expect(state.status).toBe("offering");
    expect(state.rtcId).toBe(RTC);
    expect(effects).toContainEqual({ kind: "startCapture", rtcId: RTC });
  });

  it("offerReady while offering → connecting AND emits sendOffer", () => {
    const { state, effects } = run([
      { kind: "start", rtcId: RTC },
      { kind: "offerReady", rtcId: RTC, sdp: "v=0 offer" },
    ]);
    expect(state.status).toBe("connecting");
    expect(effects).toContainEqual({ kind: "sendOffer", rtcId: RTC, sdp: "v=0 offer" });
  });

  it("answer while connecting → applyAnswer (stays connecting until peer connects)", () => {
    const { state, effects } = run([
      { kind: "start", rtcId: RTC },
      { kind: "offerReady", rtcId: RTC, sdp: "o" },
      { kind: "answer", rtcId: RTC, sdp: "a" },
    ]);
    expect(state.status).toBe("connecting");
    expect(effects).toContainEqual({ kind: "applyAnswer", rtcId: RTC, sdp: "a" });
  });

  it("remoteIce while connecting → applyRemoteIce", () => {
    const { effects } = run(
      [{ kind: "remoteIce", rtcId: RTC }],
      run([
        { kind: "start", rtcId: RTC },
        { kind: "offerReady", rtcId: RTC, sdp: "o" },
      ]).state,
    );
    expect(effects).toContainEqual({ kind: "applyRemoteIce", rtcId: RTC });
  });

  it("localIce after offering → flushLocalIce", () => {
    const { effects } = run(
      [{ kind: "localIce", rtcId: RTC }],
      run([{ kind: "start", rtcId: RTC }]).state,
    );
    expect(effects).toContainEqual({ kind: "flushLocalIce", rtcId: RTC });
  });

  it("peer connected → live", () => {
    expect(liveSession().status).toBe("live");
  });

  it("the full ordering produces startCapture → sendOffer → applyAnswer → applyRemoteIce", () => {
    const { allEffects } = run([
      { kind: "start", rtcId: RTC },
      { kind: "offerReady", rtcId: RTC, sdp: "o" },
      { kind: "answer", rtcId: RTC, sdp: "a" },
      { kind: "remoteIce", rtcId: RTC },
      { kind: "peerState", rtcId: RTC, connection: "connected" },
    ]);
    const kinds = allEffects.map((e) => e.kind);
    expect(kinds).toEqual(["startCapture", "sendOffer", "applyAnswer", "applyRemoteIce"]);
  });
});

describe("signalingReducer — stray frames are ignored", () => {
  it("an answer before any offer is dropped (no applyAnswer)", () => {
    const { state, effects } = run([{ kind: "answer", rtcId: RTC, sdp: "a" }]);
    expect(state.status).toBe("idle");
    expect(effects).toHaveLength(0);
  });

  it("an offerReady while idle is dropped", () => {
    const { state, effects } = run([{ kind: "offerReady", rtcId: RTC, sdp: "o" }]);
    expect(state.status).toBe("idle");
    expect(effects).toHaveLength(0);
  });

  it("a frame for a DIFFERENT rtcId is ignored while a session is live", () => {
    const t = signalingReducer(liveSession(), { kind: "answer", rtcId: "other", sdp: "a" });
    expect(t.state.status).toBe("live");
    expect(t.effects).toHaveLength(0);
  });

  it("a second start while connecting is ignored (no duplicate capture)", () => {
    const connecting = run([
      { kind: "start", rtcId: RTC },
      { kind: "offerReady", rtcId: RTC, sdp: "o" },
    ]).state;
    const t = signalingReducer(connecting, { kind: "start", rtcId: "rtc-2" });
    expect(t.state.rtcId).toBe(RTC);
    expect(t.effects).toHaveLength(0);
  });

  it("remoteIce after teardown (closed) is ignored", () => {
    const closed = run([
      { kind: "start", rtcId: RTC },
      { kind: "offerReady", rtcId: RTC, sdp: "o" },
      { kind: "stop", rtcId: RTC },
    ]).state;
    const t = signalingReducer(closed, { kind: "remoteIce", rtcId: RTC });
    expect(t.effects).toHaveLength(0);
  });

  it("answer arriving once already live (re-answer) is dropped", () => {
    const t = signalingReducer(liveSession(), { kind: "answer", rtcId: RTC, sdp: "a2" });
    expect(t.effects).toHaveLength(0);
  });
});

describe("signalingReducer — teardown paths", () => {
  it("stop → closed AND emits teardown + notifyClosed", () => {
    const t = signalingReducer(liveSession(), { kind: "stop", rtcId: RTC });
    expect(t.state.status).toBe("closed");
    expect(t.state.rtcId).toBeNull();
    expect(t.effects).toContainEqual({ kind: "teardown", rtcId: RTC });
    expect(t.effects.some((e) => e.kind === "notifyClosed")).toBe(true);
  });

  it("disconnect while live → closed AND emits teardown (no notify — socket is gone)", () => {
    const t = signalingReducer(liveSession(), { kind: "disconnect" });
    expect(t.state.status).toBe("closed");
    expect(t.effects).toContainEqual({ kind: "teardown", rtcId: RTC });
    expect(t.effects.some((e) => e.kind === "notifyClosed")).toBe(false);
  });

  it("peer failed → failed AND emits teardown + notifyError", () => {
    const connecting = run([
      { kind: "start", rtcId: RTC },
      { kind: "offerReady", rtcId: RTC, sdp: "o" },
    ]).state;
    const t = signalingReducer(connecting, { kind: "peerState", rtcId: RTC, connection: "failed" });
    expect(t.state.status).toBe("failed");
    expect(t.state.error).toBeTruthy();
    expect(t.effects).toContainEqual({ kind: "teardown", rtcId: RTC });
    expect(t.effects.some((e) => e.kind === "notifyError")).toBe(true);
  });

  it("capture fail → failed AND emits teardown + notifyError with the message", () => {
    const offering = run([{ kind: "start", rtcId: RTC }]).state;
    const t = signalingReducer(offering, { kind: "fail", rtcId: RTC, message: "ffmpeg not found" });
    expect(t.state.status).toBe("failed");
    expect(t.effects).toContainEqual({ kind: "notifyError", rtcId: RTC, message: "ffmpeg not found" });
  });

  it("a transient 'disconnected' peer state while CONNECTING is not terminal", () => {
    const connecting = run([
      { kind: "start", rtcId: RTC },
      { kind: "offerReady", rtcId: RTC, sdp: "o" },
    ]).state;
    const t = signalingReducer(connecting, { kind: "peerState", rtcId: RTC, connection: "disconnected" });
    expect(t.state.status).toBe("connecting");
    expect(t.effects).toHaveLength(0);
  });

  it("a 'disconnected' peer state while LIVE closes the session", () => {
    const t = signalingReducer(liveSession(), { kind: "peerState", rtcId: RTC, connection: "disconnected" });
    expect(t.state.status).toBe("closed");
    expect(t.effects).toContainEqual({ kind: "teardown", rtcId: RTC });
  });

  it("after close, a fresh start begins a new session", () => {
    const closed = signalingReducer(liveSession(), { kind: "stop", rtcId: RTC }).state;
    const t = signalingReducer(closed, { kind: "start", rtcId: "rtc-2" });
    expect(t.state.status).toBe("offering");
    expect(t.state.rtcId).toBe("rtc-2");
    expect(t.effects).toContainEqual({ kind: "startCapture", rtcId: "rtc-2" });
  });
});
