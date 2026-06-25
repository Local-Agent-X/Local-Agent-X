// BrokerScreenDialer tests — the broker↔session mapping, with NO ffmpeg/werift/socket.
// A fake SocketAdapter feeds broker ServerFrames in and captures the ClientFrames the
// dialer sends out; a fake ScreenSession records the RtcInboundFrames it receives and
// exposes the outbound `send` so we can simulate the session emitting offer/ice/control.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BrokerScreenDialer, type ScreenSessionLike } from "./broker-screen-dialer.js";
import type { SocketAdapter, CloseReason } from "./vendor/socket-adapter.js";
import { DataChannelControl, type ControlChannel, type ControlOutbound, type ScreenCommand } from "./control-channel.js";
import type { ScreenSessionOptions } from "../screen-stream/session.js";
import type { IceServerConfig, ControlTransport } from "../screen-stream/peer.js";
import type { RtcInboundFrame, RtcOutboundFrame, ScreenInputEvent } from "../screen-stream/protocol.js";
import { buildOffer, buildIce, buildDisplays, buildFocus } from "../screen-stream/protocol.js";

class FakeSocket implements SocketAdapter {
  sent: string[] = [];
  closes: CloseReason[] = [];
  private msg: ((d: string) => void) | null = null;
  private cls: ((c: number, r: string) => void) | null = null;
  send(text: string): void { this.sent.push(text); }
  close(reason: CloseReason): void { this.closes.push(reason); }
  onMessage(h: (d: string) => void): void { this.msg = h; }
  onClose(h: (c: number, r: string) => void): void { this.cls = h; }
  /** Test driver: deliver one broker ServerFrame. */
  deliver(frame: unknown): void { this.msg?.(JSON.stringify(frame)); }
  /** Test driver: the broker closed the socket (e.g. a bare 4403). */
  remoteClose(code: number, reason = ""): void { this.cls?.(code, reason); }
  /** Parsed view of the outbound ClientFrames. */
  get sentFrames(): Array<{ type: string; signal?: { kind: string; [k: string]: unknown } }> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

class SpyControl implements ControlChannel {
  sent: ControlOutbound[] = [];
  closed = 0;
  attached: ControlTransport[] = [];
  input: ((e: ScreenInputEvent) => void) | null = null;
  screen: ((cmd: ScreenCommand) => void) | null = null;
  send(frame: ControlOutbound): void { this.sent.push(frame); }
  onInput(h: (e: ScreenInputEvent) => void): void { this.input = h; }
  onScreenCommand(h: (cmd: ScreenCommand) => void): void { this.screen = h; }
  attach(t: ControlTransport): void { this.attached.push(t); }
  close(): void { this.closed++; }
}

/** A fake duplex text channel standing in for the peer's WebRTC data channel. */
class FakeTransport implements ControlTransport {
  sent: string[] = [];
  private msg: ((t: string) => void) | null = null;
  send(text: string): void { this.sent.push(text); }
  onMessage(h: (t: string) => void): void { this.msg = h; }
  onClose(_h: () => void): void { /* unused in tests */ }
  deliver(text: string): void { this.msg?.(text); }
}

class FakeSession implements ScreenSessionLike {
  frames: RtcInboundFrame[] = [];
  disconnects = 0;
  opened: Array<number | undefined> = [];
  closedScreens = 0;
  handleFrame(frame: RtcInboundFrame): void { this.frames.push(frame); }
  handleDisconnect(): void { this.disconnects++; }
  openScreen(monitor?: number): void { this.opened.push(monitor); }
  closeScreen(): void { this.closedScreens++; }
  get types(): string[] { return this.frames.map((f) => f.type); }
}

/** Wire a dialer to fakes and expose the captured session options. */
function makeDialer() {
  const socket = new FakeSocket();
  const control = new SpyControl();
  const session = new FakeSession();
  let opts!: ScreenSessionOptions;
  const dialer = new BrokerScreenDialer({
    socket,
    control,
    createSession: (o) => { opts = o; return session; },
  });
  return { dialer, socket, control, session, getOpts: () => opts };
}

const TURN: IceServerConfig[] = [{ urls: "turn:relay.example:3478", username: "u", credential: "c" }];

describe("BrokerScreenDialer — start trigger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts capture (synthesizes rtc_start) once peer-present AND ice-servers arrive", () => {
    const { socket, session, getOpts } = makeDialer();
    socket.deliver({ type: "joined", role: "desktop", peerPresent: false });
    socket.deliver({ type: "peer-joined" }); // peer-present, but no ICE yet
    expect(session.types).not.toContain("rtc_start");
    socket.deliver({ type: "ice-servers", iceServers: TURN, ttlSeconds: 300 });
    expect(session.types).toEqual(["rtc_start"]);
    // The minted servers are exposed to the peer via the session getter (D3).
    expect(getOpts().getIceServers?.()).toEqual(TURN);
  });

  it("is order-independent: ice-servers before peer-present also starts exactly once", () => {
    const { socket, session } = makeDialer();
    socket.deliver({ type: "ice-servers", iceServers: TURN, ttlSeconds: 300 });
    expect(session.types).not.toContain("rtc_start");
    socket.deliver({ type: "joined", role: "desktop", peerPresent: true });
    expect(session.frames.filter((f) => f.type === "rtc_start")).toHaveLength(1);
  });

  it("starts STUN/host-only after the grace window when a TURN-less broker sends no ice-servers", () => {
    const { socket, session, getOpts } = makeDialer();
    socket.deliver({ type: "joined", role: "desktop", peerPresent: true });
    expect(session.types).not.toContain("rtc_start");
    vi.advanceTimersByTime(2000);
    expect(session.types).toEqual(["rtc_start"]);
    expect(getOpts().getIceServers?.()).toEqual([]); // no minted servers → empty list
  });
});

describe("BrokerScreenDialer — screen open/close commands (persistent peer)", () => {
  it("starts ffmpeg only when the phone sends screen_open, and stops on screen_close", () => {
    const { control, session } = makeDialer();
    // Peer is up (chat flowing) but no capture yet — nothing opened.
    expect(session.opened).toHaveLength(0);

    control.screen?.({ kind: "open", monitor: 1 });
    expect(session.opened).toEqual([1]);

    control.screen?.({ kind: "close" });
    expect(session.closedScreens).toBe(1);
  });

  it("the session defers capture on the broker path (deferCapture)", () => {
    const { getOpts, socket } = makeDialer();
    socket.deliver({ type: "joined", role: "desktop", peerPresent: true });
    expect(getOpts().deferCapture).toBe(true);
  });
});

describe("BrokerScreenDialer — inbound signaling → session", () => {
  it("maps an answer signal to rtc_answer", () => {
    const { socket, session } = makeDialer();
    socket.deliver({ type: "signal", signal: { kind: "answer", sdp: "ANSWER_SDP" } });
    expect(session.frames).toContainEqual({ type: "rtc_answer", rtcId: expect.any(String), sdp: "ANSWER_SDP" });
  });

  it("maps an ice signal to rtc_ice, preserving null sdpMid/sdpMLineIndex", () => {
    const { socket, session } = makeDialer();
    socket.deliver({ type: "signal", signal: { kind: "ice", candidate: "cand", sdpMid: "0", sdpMLineIndex: null } });
    const ice = session.frames.find((f) => f.type === "rtc_ice");
    expect(ice).toMatchObject({ type: "rtc_ice", candidate: { candidate: "cand", sdpMid: "0", sdpMLineIndex: null } });
  });

  it("ignores an unexpected inbound offer (desktop is the offerer)", () => {
    const { socket, session } = makeDialer();
    socket.deliver({ type: "signal", signal: { kind: "offer", sdp: "X" } });
    expect(session.frames).toHaveLength(0);
  });
});

describe("BrokerScreenDialer — outbound session → broker / control", () => {
  it("relays the session's rtc_offer as a broker offer signal", () => {
    const { socket, getOpts } = makeDialer();
    getOpts().send(buildOffer("rtc-x", "OFFER_SDP"));
    expect(socket.sentFrames).toContainEqual({ type: "signal", signal: { kind: "offer", sdp: "OFFER_SDP" } });
  });

  it("relays the session's rtc_ice as a broker ice signal, coercing undefined → null", () => {
    const { socket, getOpts } = makeDialer();
    getOpts().send(buildIce("rtc-x", { candidate: "host" })); // no sdpMid/sdpMLineIndex
    expect(socket.sentFrames).toContainEqual({
      type: "signal",
      signal: { kind: "ice", candidate: "host", sdpMid: null, sdpMLineIndex: null },
    });
  });

  it("routes app-control (displays/focus/error/closed) to the ControlChannel, NOT the broker", () => {
    const { socket, control, getOpts } = makeDialer();
    getOpts().send(buildDisplays("rtc-x", 2, 0, 1920, 1080));
    expect(control.sent).toHaveLength(1);
    expect(control.sent[0].type).toBe("rtc_displays");
    expect(socket.sent).toHaveLength(0); // the broker never sees control frames
  });
});

describe("BrokerScreenDialer — control inbound + teardown", () => {
  it("feeds inbound remote input from the ControlChannel into the session", () => {
    const { control, session } = makeDialer();
    control.input?.({ kind: "click", button: "left" });
    expect(session.frames).toContainEqual({
      type: "rtc_input",
      rtcId: expect.any(String),
      event: { kind: "click", button: "left" },
    });
  });

  it("tears down the session on peer-left", () => {
    const { socket, session, control } = makeDialer();
    socket.deliver({ type: "peer-left" });
    expect(session.disconnects).toBe(1);
    expect(control.closed).toBe(1);
  });

  it("tears down on a terminal gate close (4403) and ignores later frames", () => {
    const { socket, session } = makeDialer();
    socket.remoteClose(4403, "not paired");
    expect(session.disconnects).toBe(1);
    socket.deliver({ type: "signal", signal: { kind: "answer", sdp: "late" } });
    expect(session.frames.filter((f) => f.type === "rtc_answer")).toHaveLength(0);
  });

  it("stop() closes the broker socket and tears the session down once", () => {
    const { dialer, socket, session } = makeDialer();
    dialer.stop();
    expect(socket.closes.length).toBeGreaterThanOrEqual(1);
    expect(session.disconnects).toBe(1);
    dialer.stop(); // idempotent
    expect(session.disconnects).toBe(1);
  });

  it("hands the peer's control transport to the ControlChannel via onControlTransport", () => {
    const { control, getOpts } = makeDialer();
    const transport = new FakeTransport();
    getOpts().onControlTransport?.(transport);
    expect(control.attached).toEqual([transport]);
  });
});

describe("DataChannelControl", () => {
  it("buffers outbound control until attach, then flushes in order", () => {
    const control = new DataChannelControl();
    control.send(buildDisplays("r", 2, 0, 1920, 1080));
    control.send(buildFocus("r", true));
    const transport = new FakeTransport();
    expect(transport.sent).toHaveLength(0); // nothing sent before attach
    control.attach(transport);
    expect(transport.sent.map((s) => JSON.parse(s).type)).toEqual(["rtc_displays", "rtc_focus"]);
  });

  it("sends straight through once attached", () => {
    const control = new DataChannelControl();
    const transport = new FakeTransport();
    control.attach(transport);
    control.send(buildFocus("r", false));
    expect(JSON.parse(transport.sent[0])).toMatchObject({ type: "rtc_focus", editable: false });
  });

  it("parses an inbound rtc_input frame and validates the event before delivering", () => {
    const control = new DataChannelControl();
    const events: ScreenInputEvent[] = [];
    control.onInput((e) => events.push(e));
    const transport = new FakeTransport();
    control.attach(transport);
    transport.deliver(JSON.stringify({ type: "rtc_input", rtcId: "ignored", event: { kind: "click", button: "left" } }));
    expect(events).toEqual([{ kind: "click", button: "left", double: false }]);
  });

  it("drops non-input + malformed inbound messages (never injects unvalidated events)", () => {
    const control = new DataChannelControl();
    const events: ScreenInputEvent[] = [];
    control.onInput((e) => events.push(e));
    const transport = new FakeTransport();
    control.attach(transport);
    transport.deliver("not json");
    transport.deliver(JSON.stringify({ type: "rtc_displays", count: 1 })); // not an input frame
    transport.deliver(JSON.stringify({ type: "rtc_input", event: { kind: "bogus" } })); // invalid event
    expect(events).toHaveLength(0);
  });
});
