// VoicePeer + outbound RTP pacer tests. werift is pure-JS, so a real
// RTCPeerConnection stands up in-process; the wasm Opus codec runs in-process
// too (no native addon). We assert the offer SDP shape, that pushing TTS PCM
// produces real outbound Opus RTP packets (spying on the track's writeRtp), and
// that close() is idempotent and silences the pacer.
//
// The pacer is intentionally async (lazy wasm encoder create on first tick), so
// the RTP assertions await real wall-clock ticks rather than fake timers — a
// 20ms interval plus codec warmup needs only a short, generous wait.

import { describe, it, expect } from "vitest";
import { VoicePeer } from "./voice-peer.js";
import type { VoicePeerHandlers } from "./voice-peer.js";
import { OutboundAudio, OPUS_PAYLOAD_TYPE } from "./voice-rtp-audio.js";
import type { RtpBuilders } from "./voice-rtp-audio.js";

/** Handlers that record nothing — the default for tests that don't inspect them. */
function noopHandlers(): VoicePeerHandlers {
  return {
    onLocalIce: () => {},
    onConnectionState: () => {},
    onMicPcm: () => {},
  };
}

/** A short PCM burst at the given sample rate (a low-freq sine, audible energy). */
function pcmBurst(sampleRate: number, ms: number): Int16Array {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 8000);
  }
  return out;
}

/** Sleep helper for letting the real 20ms pacer run. */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("VoicePeer", () => {
  it("createOffer() resolves to an SDP offering audio + opus", async () => {
    const peer = await VoicePeer.create(noopHandlers());
    try {
      const sdp = await peer.createOffer();
      expect(sdp).toContain("m=audio");
      // werift renders the codec name uppercase (a=rtpmap:111 OPUS/48000/2),
      // so match case-insensitively.
      expect(sdp.toLowerCase()).toContain("opus");
      expect(sdp).toMatch(new RegExp(`a=rtpmap:${OPUS_PAYLOAD_TYPE}`, "i"));
    } finally {
      await peer.close();
    }
  });

  it("writeTtsPcm causes outbound RTP packets to be written to the track", async () => {
    const peer = await VoicePeer.create(noopHandlers());
    try {
      await peer.createOffer();
      // Spy on the real outbound track's writeRtp (reach the private field via a
      // typed structural view — no `as any`).
      const inner = peer as unknown as { outboundTrack: { writeRtp: (p: unknown) => void } };
      const written: unknown[] = [];
      const realWriteRtp = inner.outboundTrack.writeRtp.bind(inner.outboundTrack);
      inner.outboundTrack.writeRtp = (p: unknown) => {
        written.push(p);
        realWriteRtp(p);
      };

      // Push ~100ms of 24kHz TTS PCM — comfortably more than one 20ms frame
      // after resampling to 48kHz.
      peer.writeTtsPcm(pcmBurst(24000, 60), 24000);
      peer.writeTtsPcm(pcmBurst(24000, 60), 24000);

      // Let the pacer + lazy encoder warm up and emit a few frames.
      await wait(250);
      expect(written.length).toBeGreaterThanOrEqual(1);
    } finally {
      await peer.close();
    }
  });

  it("close() is idempotent and stops the pacer (no further writes after close)", async () => {
    const peer = await VoicePeer.create(noopHandlers());
    await peer.createOffer();
    const inner = peer as unknown as { outboundTrack: { writeRtp: (p: unknown) => void } };
    let writeCount = 0;
    const realWriteRtp = inner.outboundTrack.writeRtp.bind(inner.outboundTrack);
    inner.outboundTrack.writeRtp = (p: unknown) => {
      writeCount += 1;
      realWriteRtp(p);
    };

    peer.writeTtsPcm(pcmBurst(24000, 60), 24000);
    await wait(120);

    await peer.close();
    // Double close must not throw.
    await expect(peer.close()).resolves.toBeUndefined();

    const afterClose = writeCount;
    // Pushing after close is a no-op, and the pacer interval is cleared.
    peer.writeTtsPcm(pcmBurst(24000, 60), 24000);
    await wait(120);
    expect(writeCount).toBe(afterClose);
  });
});

describe("OutboundAudio pacer (isolated)", () => {
  // Minimal fake RTP builders: capture the header fields we care about without
  // standing up werift. Shapes match what RtpHeader/RtpPacket expose.
  interface FakeHeaderProps {
    payloadType?: number;
    sequenceNumber?: number;
    timestamp?: number;
    ssrc?: number;
    marker?: boolean;
  }
  class FakeHeader {
    payloadType: number;
    sequenceNumber: number;
    timestamp: number;
    ssrc: number;
    marker: boolean;
    constructor(props: FakeHeaderProps = {}) {
      this.payloadType = props.payloadType ?? 0;
      this.sequenceNumber = props.sequenceNumber ?? 0;
      this.timestamp = props.timestamp ?? 0;
      this.ssrc = props.ssrc ?? 0;
      this.marker = props.marker ?? false;
    }
  }
  class FakePacket {
    constructor(
      public header: FakeHeader,
      public payload: Buffer,
    ) {}
  }
  // The fakes structurally satisfy the werift constructor signatures the helper
  // uses; cast through unknown to the declared RtpBuilders shape (no `as any`).
  const fakeBuilders = {
    RtpPacket: FakePacket,
    RtpHeader: FakeHeader,
  } as unknown as RtpBuilders;

  it("emits monotonic Opus RTP frames with timestamp += 960 and marker on the first", async () => {
    const packets: FakePacket[] = [];
    const out = new OutboundAudio(fakeBuilders, (p) => {
      packets.push(p as unknown as FakePacket);
    });
    try {
      // 120ms of 24kHz PCM -> resampled to 48kHz is ~5760 samples -> 6 frames.
      out.push(pcmBurst(24000, 120), 24000);
      await wait(300);
      expect(packets.length).toBeGreaterThanOrEqual(2);

      for (const p of packets) {
        expect(p.header.payloadType).toBe(OPUS_PAYLOAD_TYPE);
        expect(p.payload.length).toBeGreaterThan(0);
      }
      // First packet of the talkspurt is marked; subsequent ones are not.
      expect(packets[0].header.marker).toBe(true);
      expect(packets[1].header.marker).toBe(false);
      // Sequence numbers increment by 1, timestamps by 960 (the frame size).
      expect(packets[1].header.sequenceNumber).toBe(
        (packets[0].header.sequenceNumber + 1) & 0xffff,
      );
      expect(packets[1].header.timestamp).toBe(
        (packets[0].header.timestamp + 960) >>> 0,
      );
      // Stable ssrc across the talkspurt.
      expect(packets[1].header.ssrc).toBe(packets[0].header.ssrc);
    } finally {
      out.close();
    }
  });

  it("does not emit an RTP packet for a DTX/empty Opus frame (silence)", async () => {
    const packets: FakePacket[] = [];
    const out = new OutboundAudio(fakeBuilders, (p) => {
      packets.push(p as unknown as FakePacket);
    });
    try {
      // ~1s of pure silence at 24kHz. After resample + DTX warmup the encoder
      // settles into "transmit nothing" frames; the pacer must skip those, so
      // far fewer packets are emitted than the ~50 ticks the buffer could fill.
      out.push(new Int16Array(24000), 24000);
      await wait(700);

      // The DTX frames produce no RTP packets, so we never emit a full run of
      // frames; crucially, none of the few we do emit may carry an empty/stray
      // (<=2 byte DTX) payload — that would be a malformed Opus RTP frame.
      const ticksWorth = 700 / 20;
      expect(packets.length).toBeLessThan(ticksWorth / 2);
      for (const p of packets) {
        expect(p.payload.length).toBeGreaterThan(2);
      }
    } finally {
      out.close();
    }
  });

  it("flush() drops buffered audio: pacer goes silent until new PCM, then resumes a fresh talkspurt", async () => {
    const packets: FakePacket[] = [];
    const out = new OutboundAudio(fakeBuilders, (p) => {
      packets.push(p as unknown as FakePacket);
    });
    try {
      // Buffer ~1s of audible 24kHz PCM — far more than real-time, so after a
      // few ticks the pacer has emitted some frames but seconds remain queued
      // (exactly the faster-than-real-time barge-in scenario).
      out.push(pcmBurst(24000, 1000), 24000);
      await wait(120); // let the encoder warm up + emit a handful of frames
      const beforeFlush = packets.length;
      expect(beforeFlush).toBeGreaterThanOrEqual(1);

      // Barge-in: flush drops every queued sample. The pacer + encoder stay
      // alive, but with an empty buffer no further packets are emitted.
      out.flush();
      await wait(120); // several 20ms ticks pass
      expect(packets.length).toBe(beforeFlush); // dead silence after flush

      // A new reply: writing fresh PCM resumes emission, and the first packet
      // of the new talkspurt is marked (the phone's jitter buffer resyncs).
      out.push(pcmBurst(24000, 120), 24000);
      await wait(250);
      expect(packets.length).toBeGreaterThan(beforeFlush);
      const resumed = packets[beforeFlush];
      expect(resumed.header.marker).toBe(true);
    } finally {
      out.close();
    }
  });

  it("close() stops the pacer and a short buffer never blocks", async () => {
    const packets: FakePacket[] = [];
    const out = new OutboundAudio(fakeBuilders, (p) => {
      packets.push(p as unknown as FakePacket);
    });
    // A sub-frame push (5ms @ 24kHz << 960 samples @ 48kHz) must not throw and
    // must not emit a partial frame.
    out.push(pcmBurst(24000, 5), 24000);
    await wait(80);
    expect(packets.length).toBe(0);

    out.close();
    // Idempotent close.
    expect(() => out.close()).not.toThrow();
  });
});
