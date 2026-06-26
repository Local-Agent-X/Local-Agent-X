// BrokerVoiceDialer tests — the broker↔VoicePeer mapping, with NO werift and NO socket.
// A fake SocketAdapter feeds broker ServerFrames in + captures the ClientFrames out; a
// fake VoicePeer records the answer/ice it receives and exposes its handlers so we can
// simulate the peer trickling local ICE.

import { describe, it, expect } from "vitest";
import { BrokerVoiceDialer, type VoicePeerLike } from "./broker-voice-dialer.js";
import type { SocketAdapter, CloseReason } from "./vendor/socket-adapter.js";
import type { VoicePeerHandlers, RtcIceCandidate } from "../voice/voice-peer.js";
import type { ControlTransport, IceServerConfig } from "../screen-stream/peer.js";
import type { VoiceSession, VoiceSessionContext } from "../voice/audio-ws.js";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeSocket implements SocketAdapter {
  sent: string[] = [];
  closes: CloseReason[] = [];
  private msg: ((d: string) => void) | null = null;
  private cls: ((c: number, r: string) => void) | null = null;
  send(text: string): void { this.sent.push(text); }
  close(reason: CloseReason): void { this.closes.push(reason); }
  onMessage(h: (d: string) => void): void { this.msg = h; }
  onClose(h: (c: number, r: string) => void): void { this.cls = h; }
  deliver(frame: unknown): void { this.msg?.(JSON.stringify(frame)); }
  remoteClose(code: number, reason = ""): void { this.cls?.(code, reason); }
  get sentFrames(): Array<{ type: string; signal?: { kind: string; [k: string]: unknown } }> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

class FakePeer implements VoicePeerLike {
  answers: string[] = [];
  ices: RtcIceCandidate[] = [];
  closed = 0;
  constructor(
    public readonly handlers: VoicePeerHandlers,
    public readonly ice: IceServerConfig[],
    public readonly onControl: (t: ControlTransport) => void,
  ) {}
  createOffer(): Promise<string> { return Promise.resolve("VOICE_OFFER"); }
  applyAnswer(sdp: string): Promise<void> { this.answers.push(sdp); return Promise.resolve(); }
  addRemoteIce(c: RtcIceCandidate): Promise<void> { this.ices.push(c); return Promise.resolve(); }
  writeTtsPcm(): void { /* unused */ }
  interruptTts(): void { /* unused */ }
  close(): Promise<void> { this.closed++; return Promise.resolve(); }
}

class FakeSession implements VoiceSession {
  onMicFrame(): void { /* unused */ }
  close(): void { /* unused */ }
}

function makeDialer() {
  const socket = new FakeSocket();
  const peers: FakePeer[] = [];
  const closed = { count: 0 };
  const sessionFactory = (_ctx: VoiceSessionContext): VoiceSession => new FakeSession();
  const dialer = new BrokerVoiceDialer({
    socket,
    sessionFactory,
    createPeer: (h, ice, onCtrl) => {
      const p = new FakePeer(h, ice, onCtrl);
      peers.push(p);
      return Promise.resolve(p);
    },
    onClosed: () => { closed.count++; },
  });
  return { socket, peers, closed, dialer };
}

describe("BrokerVoiceDialer — startup", () => {
  it("builds the voice peer with the minted ICE and sends the offer once present + ice-servers arrive", async () => {
    const { socket, peers } = makeDialer();
    socket.deliver({ type: "joined", role: "desktop", peerPresent: false });
    socket.deliver({ type: "peer-joined" });
    socket.deliver({ type: "ice-servers", iceServers: [{ urls: "turn:x", username: "u", credential: "c" }], ttlSeconds: 300 });
    await flush();
    expect(peers.length).toBe(1);
    expect(peers[0]!.ice).toEqual([{ urls: "turn:x", username: "u", credential: "c" }]);
    expect(socket.sentFrames).toContainEqual({ type: "signal", signal: { kind: "offer", sdp: "VOICE_OFFER" } });
  });

  it("starts STUN/host-only after the grace window when no ice-servers arrive", async () => {
    const { socket, peers } = makeDialer();
    socket.deliver({ type: "joined", role: "desktop", peerPresent: true });
    // No ice-servers; wait out the 2s grace.
    await new Promise((r) => setTimeout(r, 2100));
    expect(peers.length).toBe(1);
    expect(peers[0]!.ice).toEqual([]);
    expect(socket.sentFrames.some((f) => f.signal?.kind === "offer")).toBe(true);
  });
});

describe("BrokerVoiceDialer — signaling", () => {
  it("applies an inbound answer and ICE to the peer", async () => {
    const { socket, peers } = makeDialer();
    socket.deliver({ type: "peer-joined" });
    socket.deliver({ type: "ice-servers", iceServers: [{ urls: "stun:x" }], ttlSeconds: 300 });
    await flush();
    socket.deliver({ type: "signal", signal: { kind: "answer", sdp: "ANS" } });
    socket.deliver({ type: "signal", signal: { kind: "ice", candidate: "c", sdpMid: "0", sdpMLineIndex: 0 } });
    await flush();
    expect(peers[0]!.answers).toEqual(["ANS"]);
    expect(peers[0]!.ices).toEqual([{ candidate: "c", sdpMid: "0", sdpMLineIndex: 0 }]);
  });

  it("relays the peer's local ICE to the broker, dropping the end-of-candidates null", async () => {
    const { socket, peers } = makeDialer();
    socket.deliver({ type: "peer-joined" });
    socket.deliver({ type: "ice-servers", iceServers: [{ urls: "stun:x" }], ttlSeconds: 300 });
    await flush();
    peers[0]!.handlers.onLocalIce({ candidate: "host", sdpMid: null, sdpMLineIndex: null });
    peers[0]!.handlers.onLocalIce(null); // end-of-candidates — NOT relayed
    const iceFrames = socket.sentFrames.filter((f) => f.signal?.kind === "ice");
    expect(iceFrames).toEqual([
      { type: "signal", signal: { kind: "ice", candidate: "host", sdpMid: null, sdpMLineIndex: null } },
    ]);
  });
});

describe("BrokerVoiceDialer — lifecycle", () => {
  it("rebuilds the peer on peer-left (closes the stale peer, keeps the socket)", async () => {
    const { socket, peers } = makeDialer();
    socket.deliver({ type: "peer-joined" });
    socket.deliver({ type: "ice-servers", iceServers: [{ urls: "stun:x" }], ttlSeconds: 300 });
    await flush();
    socket.deliver({ type: "peer-left" });
    await flush();
    expect(peers[0]!.closed).toBe(1);
    expect(socket.closes.length).toBe(0); // socket kept
    socket.deliver({ type: "peer-joined" });
    socket.deliver({ type: "ice-servers", iceServers: [{ urls: "stun:y" }], ttlSeconds: 300 });
    await flush();
    expect(peers.length).toBe(2);
  });

  it("tears down + fires onClosed when the broker socket closes", async () => {
    const { socket, peers, closed } = makeDialer();
    socket.deliver({ type: "peer-joined" });
    socket.deliver({ type: "ice-servers", iceServers: [{ urls: "stun:x" }], ttlSeconds: 300 });
    await flush();
    socket.remoteClose(1006);
    expect(closed.count).toBe(1);
    expect(peers[0]!.closed).toBe(1);
  });
});
