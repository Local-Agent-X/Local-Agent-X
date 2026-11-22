// A closed phone peer leaves nothing open. With werift's default bundle policy
// each m-line (video or audio, plus the data channels) gathered its own ICE
// transport; the phone's answer bundles them, and close() never reached the
// one bundling dropped: its sockets and TURN allocation lived until the
// process ended, one per phone connection, renewing every 500 s and failing
// loudly once the network reset it (2026-11-18, ~150 ERR_STREAM_DESTROYED
// bursts a day). Real werift on both ends; the answerer stands in for the
// phone, which answers bundled.
import { describe, it, expect, afterEach } from "vitest";
import * as werift from "werift";
import { ScreenPeer, type ControlTransport } from "./peer.js";
import { VoicePeer } from "../voice/voice-peer.js";
import type { RtcIceCandidate } from "../webrtc/werift.js";

interface IceConnection { state: string; protocols: unknown[] }
const proto = (werift as unknown as { Connection: { prototype: { gatherCandidates: (...a: unknown[]) => Promise<void> } } })
  .Connection.prototype;
const gather = proto.gatherCandidates;
const opened = new Set<IceConnection>();
proto.gatherCandidates = function (this: IceConnection, ...a: unknown[]) { opened.add(this); return gather.apply(this, a); };

afterEach(() => { opened.clear(); });

interface Offerer {
  createOffer(): Promise<string>;
  applyAnswer(sdp: string): Promise<void>;
  addRemoteIce(c: RtcIceCandidate): Promise<void>;
  close(): Promise<void>;
}

/** Connect `make`'s peer to a werift answerer, close both, report what is still open. */
async function leftOpen(make: (onIce: (c: RtcIceCandidate | null) => void, onControl: (t: ControlTransport) => void) => Promise<Offerer>): Promise<string[]> {
  const phone = new werift.RTCPeerConnection({});
  let controlOpen!: () => void;
  const ready = new Promise<void>((r) => { controlOpen = r; });
  const desktop = await make((c) => { if (c) void phone.addIceCandidate(c); }, () => controlOpen());
  phone.onicecandidate = ({ candidate }) => {
    if (candidate) void desktop.addRemoteIce({ candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null });
  };
  phone.ondatachannel = () => undefined;
  await phone.setRemoteDescription({ type: "offer", sdp: await desktop.createOffer() });
  await phone.setLocalDescription(await phone.createAnswer());
  await desktop.applyAnswer(phone.localDescription!.sdp);
  await ready;
  await desktop.close();
  await phone.close();
  return [...opened]
    .filter((c) => c.state !== "closed" || c.protocols.length > 0)
    .map((c) => `${c.state}, ${c.protocols.length} socket(s) open`);
}

const handlers = (onIce: (c: RtcIceCandidate | null) => void) => ({ onLocalIce: onIce, onConnectionState: () => undefined });

describe("closing a phone peer", () => {
  it("closes every ICE connection the screen and chat peer opened", async () => {
    const open = await leftOpen((onIce, onControl) => ScreenPeer.create(handlers(onIce), [], onControl, [{ label: "chat", onReady: () => undefined }]));
    expect(open).toEqual([]);
  }, 20_000);

  it("closes every ICE connection the voice peer opened", async () => {
    const open = await leftOpen((onIce, onControl) => VoicePeer.create({ ...handlers(onIce), onMicPcm: () => undefined }, [], onControl));
    expect(open).toEqual([]);
  }, 20_000);
});
