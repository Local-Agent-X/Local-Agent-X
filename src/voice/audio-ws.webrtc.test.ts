// WebRTC signaling branch of the /ws/voice handler. Drives the REAL handler
// end-to-end: a real node:http server on an ephemeral loopback port, the real
// setupVoiceWebSocket() upgrade + connection wiring, and a real `ws` client.
// A FAKE peer (setVoicePeerFactory) and FAKE session (setVoiceSessionFactory)
// are injected so we can observe routing without pulling in werift/opus.
//
// End-to-end is the right strategy here: setupVoiceWebSocket already takes a
// real http.Server, the legacy PCM path can only be proven intact by exercising
// the actual binary branch, and the signaling is inherently a wire protocol —
// testing it over a real socket proves the message shapes the phone client must
// mirror, not just an extracted function in isolation.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

import {
  setupVoiceWebSocket,
  setVoiceSessionFactory,
  setVoicePeerFactory,
} from "./audio-ws.js";

const AUTH = "OP_TOKEN_test_audio_ws_webrtc";
const FAKE_OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\nfake-offer\r\n";

interface IceLike { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }

// Records every call so the test can assert routing. Returns a canned offer.
class FakePeer {
  readonly answers: string[] = [];
  readonly remoteIce: IceLike[] = [];
  readonly ttsWrites: { len: number; rate: number }[] = [];
  closed = false;
  constructor(
    readonly handlers: {
      onLocalIce: (c: IceLike | null) => void;
      onConnectionState: (s: string) => void;
      onMicPcm: (frame: Int16Array) => void;
    },
  ) {}
  async createOffer(): Promise<string> { return FAKE_OFFER_SDP; }
  async applyAnswer(sdp: string): Promise<void> { this.answers.push(sdp); }
  async addRemoteIce(c: IceLike): Promise<void> { this.remoteIce.push(c); }
  writeTtsPcm(frame: Int16Array, sampleRate: number): void {
    this.ttsWrites.push({ len: frame.length, rate: sampleRate });
  }
  async close(): Promise<void> { this.closed = true; }
}

// A fake session that exposes the ctx so the test can drive sendAudio/sendEvent
// (the TTS direction) and observe onMicFrame (the mic direction).
interface SessionCtxLike {
  sendAudio: (frame: Int16Array) => void;
  sendEvent: (event: Record<string, unknown>) => void;
}
class FakeSession {
  readonly micFrames: Int16Array[] = [];
  closed = false;
  constructor(readonly ctx: SessionCtxLike) {}
  onMicFrame(frame: Int16Array): void { this.micFrames.push(frame); }
  close(): void { this.closed = true; }
}

let server: Server;
let port: number;
let lastPeer: FakePeer | null = null;
let lastSession: FakeSession | null = null;

beforeEach(async () => {
  lastPeer = null;
  lastSession = null;
  setVoicePeerFactory(async (h) => (lastPeer = new FakePeer(h)));
  setVoiceSessionFactory((ctx) => (lastSession = new FakeSession(ctx)));

  server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  setupVoiceWebSocket(server, AUTH, 1024 * 1024);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice?token=${AUTH}`);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Collect the next JSON event whose `type` matches. */
function nextEvent(ws: WebSocket, type: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", onMsg); reject(new Error(`timeout waiting for ${type}`)); }, timeoutMs);
    function onMsg(data: Buffer, isBinary: boolean): void {
      if (isBinary) return;
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === type) { clearTimeout(timer); ws.off("message", onMsg); resolve(msg); }
    }
    ws.on("message", onMsg);
  });
}

/** Resolve with the next binary frame. */
function nextBinary(ws: WebSocket, timeoutMs = 2000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", onMsg); reject(new Error("timeout waiting for binary")); }, timeoutMs);
    function onMsg(data: Buffer, isBinary: boolean): void {
      if (!isBinary) return;
      clearTimeout(timer); ws.off("message", onMsg); resolve(data);
    }
    ws.on("message", onMsg);
  });
}

/** Wait until the injected peer exists (its async IIFE has run). */
async function waitForPeer(timeoutMs = 2000): Promise<FakePeer> {
  const start = Date.now();
  while (!lastPeer) {
    if (Date.now() - start > timeoutMs) throw new Error("peer never created");
    await new Promise((r) => setTimeout(r, 10));
  }
  return lastPeer;
}

describe("/ws/voice webrtc transport", () => {
  it("hello{transport:webrtc} → creates a peer and sends rtc_offer with the fake SDP", async () => {
    const ws = await connect();
    const offerP = nextEvent(ws, "rtc_offer");
    ws.send(JSON.stringify({ type: "hello", sessionId: "s1", transport: "webrtc" }));
    const offer = await offerP;
    expect(offer.sdp).toBe(FAKE_OFFER_SDP);
    expect(lastPeer).not.toBeNull();
    ws.close();
  });

  it("rtc_answer → peer.applyAnswer; rtc_ice(candidate) → peer.addRemoteIce; null ice ignored", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "hello", sessionId: "s2", transport: "webrtc" }));
    await nextEvent(ws, "rtc_offer");
    const peer = await waitForPeer();

    ws.send(JSON.stringify({ type: "rtc_answer", sdp: "answer-sdp" }));
    const cand: IceLike = { candidate: "candidate:1 1 udp", sdpMid: "0", sdpMLineIndex: 0 };
    ws.send(JSON.stringify({ type: "rtc_ice", candidate: cand }));
    ws.send(JSON.stringify({ type: "rtc_ice", candidate: null }));

    await viPoll(() => peer.answers.length === 1 && peer.remoteIce.length === 1);
    expect(peer.answers).toEqual(["answer-sdp"]);
    expect(peer.remoteIce).toEqual([cand]); // null was ignored, not pushed
    ws.close();
  });

  it("local ICE from the peer is forwarded to the client as rtc_ice", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "hello", sessionId: "s3", transport: "webrtc" }));
    await nextEvent(ws, "rtc_offer");
    const peer = await waitForPeer();

    const iceP = nextEvent(ws, "rtc_ice");
    const local: IceLike = { candidate: "candidate:local", sdpMid: "0", sdpMLineIndex: 0 };
    peer.handlers.onLocalIce(local);
    const ice = await iceP;
    expect(ice.candidate).toEqual(local);
    ws.close();
  });

  it("mic PCM from the peer routes to session.onMicFrame; TTS sendAudio routes to peer.writeTtsPcm at the snooped rate", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "hello", sessionId: "s4", transport: "webrtc" }));
    await nextEvent(ws, "rtc_offer");
    const peer = await waitForPeer();
    expect(lastSession).not.toBeNull();
    const session = lastSession!;

    // Mic direction: peer decodes a frame → onMicPcm → session.onMicFrame.
    const micFrame = new Int16Array([1, 2, 3, 4]);
    peer.handlers.onMicPcm(micFrame);
    expect(session.micFrames).toHaveLength(1);
    expect(Array.from(session.micFrames[0])).toEqual([1, 2, 3, 4]);

    // Snoop the TTS rate off a voice_ready event, then TTS → peer.writeTtsPcm.
    session.ctx.sendEvent({ type: "voice_ready", ttsSampleRate: 24000 });
    const ttsFrame = new Int16Array([10, 20, 30]);
    session.ctx.sendAudio(ttsFrame);
    expect(peer.ttsWrites).toEqual([{ len: 3, rate: 24000 }]);
    ws.close();
  });

  it("voice_ready is still delivered to the client over the WS in webrtc mode (control plane stays on WS)", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "hello", sessionId: "s5", transport: "webrtc" }));
    await nextEvent(ws, "rtc_offer");
    const session = lastSession!;
    const readyP = nextEvent(ws, "voice_ready");
    session.ctx.sendEvent({ type: "voice_ready", ttsSampleRate: 24000, gpu: false });
    const ready = await readyP;
    expect(ready.ttsSampleRate).toBe(24000);
    ws.close();
  });

  it("connection state 'failed' → closes peer+session and sends error{webrtc_failed} to the client", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "hello", sessionId: "s6", transport: "webrtc" }));
    await nextEvent(ws, "rtc_offer");
    const peer = await waitForPeer();
    const session = lastSession!;

    const errP = nextEvent(ws, "error");
    peer.handlers.onConnectionState("failed");
    const err = await errP;
    expect(err.message).toBe("webrtc_failed");
    await viPoll(() => peer.closed && session.closed);
    expect(peer.closed).toBe(true);
    expect(session.closed).toBe(true);
    ws.close();
  });

  it("teardown is idempotent: after a 'failed' teardown, a ws close does NOT double-close (count stays 1)", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "hello", sessionId: "s7", transport: "webrtc" }));
    await nextEvent(ws, "rtc_offer");
    const peer = await waitForPeer();
    const session = lastSession!;

    // Count close() calls on both fakes.
    let peerCloses = 0;
    let sessionCloses = 0;
    const realPeerClose = peer.close.bind(peer);
    peer.close = async () => { peerCloses++; return realPeerClose(); };
    const realSessionClose = session.close.bind(session);
    session.close = () => { sessionCloses++; realSessionClose(); };

    const errP = nextEvent(ws, "error");
    peer.handlers.onConnectionState("failed");
    await errP;
    await viPoll(() => peer.closed && session.closed);
    expect(peerCloses).toBe(1);
    expect(sessionCloses).toBe(1);

    // Now close the socket — teardown must be a no-op, not a second close/throw.
    await new Promise<void>((res) => { ws.once("close", () => res()); ws.close(); });
    await viPoll(() => true); // let the server-side close handler run
    expect(peerCloses).toBe(1);
    expect(sessionCloses).toBe(1);
  });

  it("non-terminal states ('connected' then 'disconnected') do NOT tear down", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "hello", sessionId: "s8", transport: "webrtc" }));
    await nextEvent(ws, "rtc_offer");
    const peer = await waitForPeer();
    const session = lastSession!;

    peer.handlers.onConnectionState("connected");
    peer.handlers.onConnectionState("disconnected");
    // Give any erroneous async teardown a chance to run before asserting.
    await new Promise((r) => setTimeout(r, 50));
    expect(peer.closed).toBe(false);
    expect(session.closed).toBe(false);
    ws.close();
  });
});

describe("/ws/voice legacy PCM transport (unchanged)", () => {
  it("hello WITHOUT transport → NO peer; a binary frame reaches session.onMicFrame", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "hello", sessionId: "p1" }));
    await nextEvent(ws, "ready");
    expect(lastPeer).toBeNull(); // legacy path never builds a peer
    const session = lastSession!;

    // 2 samples = 4 bytes of Int16 PCM.
    const pcm = Buffer.from(new Int16Array([7, -7]).buffer);
    ws.send(pcm, { binary: true });
    await viPoll(() => session.micFrames.length === 1);
    expect(Array.from(session.micFrames[0])).toEqual([7, -7]);
    expect(lastPeer).toBeNull();
    ws.close();
  });

  it("legacy sendAudio echoes back as a binary frame over the WS (no peer)", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "hello", sessionId: "p2" }));
    await nextEvent(ws, "ready");
    const session = lastSession!;

    const echoP = nextBinary(ws);
    session.ctx.sendAudio(new Int16Array([5, 6]));
    const got = await echoP;
    expect(Array.from(new Int16Array(got.buffer, got.byteOffset, got.byteLength / 2))).toEqual([5, 6]);
    expect(lastPeer).toBeNull();
    ws.close();
  });
});

/** Poll a predicate until true or timeout. */
async function viPoll(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("viPoll timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
