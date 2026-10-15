// The live screen's feedback loop against a real werift receiver, in process over
// loopback: what StreamQuality depends on actually happens. The phone's receiver
// reports reach onStreamReport, its keyframe requests reach onKeyframeRequest, and a
// restarted capture (new random RTP sequence numbers) arrives as one continuous stream.

import { describe, it, expect, afterEach } from "vitest";
import { RTCPeerConnection, RtpHeader, RtpPacket, useVP8, type MediaStreamTrack } from "werift";
import { ScreenPeer } from "./peer.js";
import { VP8_CLOCK_RATE, VP8_PAYLOAD_TYPE } from "./ffmpeg-capture.js";
import type { StreamReport } from "./bitrate-ladder.js";

const open: Array<{ close(): Promise<unknown> | void }> = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

/** Resolve once `done()` holds, polling; fail after `ms` (a loaded test machine is slow). */
async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A VP8 RTP packet as ffmpeg would send it (the payload is opaque to the peer). */
function rtp(sequenceNumber: number, timestamp: number): Buffer {
  const header = new RtpHeader({ payloadType: VP8_PAYLOAD_TYPE, sequenceNumber, timestamp, ssrc: 1234, marker: true });
  return new RtpPacket(header, Buffer.from([0x10, 0x00, 0x9d, 0x01, 0x2a])).serialize();
}

async function connect(): Promise<{ desktop: ScreenPeer; phone: RTCPeerConnection; track: MediaStreamTrack }> {
  const phone = new RTCPeerConnection({ codecs: { video: [useVP8({ payloadType: VP8_PAYLOAD_TYPE, clockRate: VP8_CLOCK_RATE })] } });
  open.push(phone);
  const desktop = await ScreenPeer.create(
    {
      onLocalIce: (c) => {
        if (c) void phone.addIceCandidate({ candidate: c.candidate, sdpMid: c.sdpMid ?? undefined, sdpMLineIndex: c.sdpMLineIndex ?? undefined });
      },
      onConnectionState: () => {},
    },
    [],
  );
  open.push(desktop);
  phone.onIceCandidate.subscribe((c) => {
    if (c?.candidate) void desktop.addRemoteIce({ candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null });
  });
  const track = new Promise<MediaStreamTrack>((resolve) => phone.onTrack.subscribe(resolve));
  await phone.setRemoteDescription({ type: "offer", sdp: await desktop.createOffer() });
  await phone.setLocalDescription(await phone.createAnswer());
  await desktop.applyAnswer(phone.localDescription!.sdp);
  await phone.connectionStateChange.watch((s) => s === "connected");
  return { desktop, phone, track: await track };
}

describe("ScreenPeer feedback against a real receiver", () => {
  it("a restarted capture continues the stream: sequence numbers carry on, no jump", async () => {
    const { desktop, track } = await connect();
    const seqs: number[] = [];
    track.onReceiveRtp.subscribe((p) => seqs.push(p.header.sequenceNumber));

    for (let i = 0; i < 5; i += 1) desktop.writeRtp(rtp(1000 + i, 90_000 + i * 6000));
    desktop.startNewStream(); // ffmpeg restarted: its sequence starts somewhere else entirely
    for (let i = 0; i < 5; i += 1) desktop.writeRtp(rtp(50_000 + i, 7_000_000 + i * 6000));
    await until(() => seqs.length >= 10);

    expect(seqs.length).toBe(10);
    const steps = seqs.slice(1).map((s, i) => (s - seqs[i]! + 65536) % 65536);
    expect(steps.every((d) => d >= 1 && d <= 3)).toBe(true); // werift marks the seam with a small gap
  }, 20_000);

  it("the phone's receiver reports and keyframe requests reach the handlers", async () => {
    const { desktop, phone } = await connect();
    const reports: StreamReport[] = [];
    let keyframes = 0;
    desktop.onStreamReport((r) => reports.push(r));
    desktop.onKeyframeRequest(() => (keyframes += 1));

    for (let i = 0; i < 30; i += 1) {
      desktop.writeRtp(rtp(i, i * 6000));
      await new Promise((r) => setTimeout(r, 66));
    }
    const receiver = phone.getTransceivers()[0]!.receiver;
    await receiver.sendRtcpPLI(receiver.tracks[0]!.ssrc!);
    await until(() => reports.length > 0 && keyframes > 0);

    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]!.fractionLost).toBeGreaterThanOrEqual(0);
    expect(reports[0]!.fractionLost).toBeLessThanOrEqual(1);
    expect(keyframes).toBe(1);
  }, 20_000);
});
