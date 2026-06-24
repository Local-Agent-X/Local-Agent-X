// Outbound audio framing + RTP pacer for the desktop voice peer.
//
// Split out of voice-peer.ts to keep each file under the repo's hard 400-LOC
// source-hygiene gate AND because the framing/pacing logic is the one piece
// worth unit-testing without standing up a real RTCPeerConnection: feed it TTS
// PCM, tick the clock, assert it emits well-formed 20ms Opus RTP packets.
//
// Responsibility: TTS Int16 PCM (any sample rate) -> resample to 48kHz -> buffer
// -> a 20ms pacer pulls 960-sample frames, Opus-encodes them, and emits a fully
// built RtpPacket (monotonic sequenceNumber, timestamp += 960, stable ssrc,
// payloadType 111, marker on the first packet of a talkspurt). It owns the
// encoder lifecycle and the setInterval; the peer just constructs it, pushes
// PCM, and closes it. It knows nothing about signaling or the inbound path.

import type { RtpPacket as WeriftRtpPacket, RtpHeader as WeriftRtpHeader } from "werift";
import { createOpusEncoder, resampleInt16, OPUS_SAMPLE_RATE, OPUS_FRAME_SAMPLES } from "./opus-codec.js";
import type { OpusEncoder } from "./opus-codec.js";
import { createLogger } from "../logger.js";

const logger = createLogger("voice.rtp-audio");

/** 20ms cadence — one Opus frame (960 samples @ 48kHz) per tick. */
const PACER_INTERVAL_MS = 20;
/** Outbound jitter cushion: queue this much before draining a talkspurt so
 *  bursty/jittery TTS delivery (edge-tts ships MP3 in uneven bursts) can't drain
 *  the buffer to empty mid-utterance. An empty buffer re-marks a talkspurt →
 *  the phone's jitter buffer resyncs → a dropped syllable. 100ms is inaudible as
 *  added latency next to multi-second LLM time-to-first-token but absorbs the
 *  bursts. */
const PREBUFFER_SAMPLES = 5 * OPUS_FRAME_SAMPLES; // ~100ms @ 48kHz
/** Opus payload type advertised in the offer SDP (standard dynamic PT for Opus). */
export const OPUS_PAYLOAD_TYPE = 111;

/** The subset of the werift module this helper builds RTP packets with. */
export interface RtpBuilders {
  RtpPacket: new (header: WeriftRtpHeader, payload: Buffer) => WeriftRtpPacket;
  RtpHeader: new (props?: Partial<WeriftRtpHeader>) => WeriftRtpHeader;
}

/** Sink for a finished outbound RTP packet (the peer forwards it to the track). */
export type RtpSink = (packet: WeriftRtpPacket) => void;

/**
 * Buffers TTS PCM and paces 20ms Opus RTP packets to a sink.
 *
 * The encoder is created lazily on the first frame that's actually ready to
 * encode (not at construction) so a peer that never speaks never spins up the
 * wasm encoder. A SETUP failure (encoder creation) is surfaced via the pacer's
 * async tick rejection path — it is logged at error level and the pacer keeps
 * ticking so a transient failure doesn't permanently wedge the talkspurt; per-
 * frame encode errors drop that frame only.
 *
 * The encoder runs with DTX DISABLED (continuous transmission) for smooth
 * cadence — see getEncoder(). emitFrame() still defensively guards against a
 * stray empty payload (sends no RTP for it, advancing the timestamp clock but
 * not the sequence number), keeping the stream well-formed if one ever appears.
 */
export class OutboundAudio {
  private readonly rtp: RtpBuilders;
  private readonly sink: RtpSink;

  /** 48kHz mono Int16 PCM awaiting framing. Grows on push, drains on tick. */
  private pending: Int16Array = new Int16Array(0);
  private encoder: OpusEncoder | null = null;
  /** In-flight lazy encoder creation, so concurrent ticks share one create. */
  private encoderInit: Promise<OpusEncoder> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private closed = false;

  // RTP sequencing state. ssrc is stable-random per peer; the phone keys its
  // jitter buffer on it. timestamp advances by the frame's sample count (960)
  // in the 48kHz clock. marker flags the first packet after silence.
  private readonly ssrc: number;
  private sequenceNumber: number;
  private timestamp: number;
  private talkspurtStart = true;
  // Once a talkspurt's cushion is built we drain continuously; brief sub-cushion
  // dips are waited out (not re-marked). Reset when the buffer truly empties.
  private primed = false;

  constructor(rtp: RtpBuilders, sink: RtpSink) {
    this.rtp = rtp;
    this.sink = sink;
    // 32-bit ssrc, 16-bit initial seq, 32-bit initial timestamp — random
    // initial values per RFC 3550 (the RtpHeader docstrings call for this).
    this.ssrc = (Math.random() * 0xffffffff) >>> 0;
    this.sequenceNumber = (Math.random() * 0xffff) & 0xffff;
    this.timestamp = (Math.random() * 0xffffffff) >>> 0;
  }

  /**
   * Push one TTS PCM frame. Resamples to 48kHz, appends to the pending buffer,
   * and starts the pacer on the first push. Never blocks.
   */
  push(frame: Int16Array, sampleRate: number): void {
    if (this.closed || frame.length === 0) return;
    const at48k = resampleInt16(frame, sampleRate, OPUS_SAMPLE_RATE);
    this.appendPending(at48k);
    this.ensurePacer();
  }

  /**
   * Drop all queued PCM immediately (barge-in / interrupt). The desktop
   * synthesizes TTS faster than real-time, so on interrupt the pacer's pending
   * buffer can hold seconds of already-encoded reply; flushing it makes the
   * agent go silent on the phone within ~one frame instead of draining it out.
   *
   * Keeps the encoder + pacer alive so the next reply streams normally — this
   * is the same state the pacer reaches when the buffer drains mid-utterance:
   * we clear `pending` and re-arm `talkspurtStart` so the next real frame opens
   * a fresh talkspurt (marker set), exactly like the post-silence resume in
   * tick()/emitFrame(). Sequence number is NOT touched (it counts transmitted
   * packets, so flushing just sends fewer); the timestamp clock is left as-is
   * and the new talkspurt's marker tells the phone's jitter buffer to resync.
   */
  flush(): void {
    if (this.closed) return;
    this.pending = new Int16Array(0);
    this.talkspurtStart = true;
    this.primed = false; // next reply rebuilds its prebuffer cushion
  }

  /** Stop the pacer and free the encoder. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.encoder) {
      this.encoder.free();
      this.encoder = null;
    }
    this.encoderInit = null;
    this.pending = new Int16Array(0);
  }

  private appendPending(extra: Int16Array): void {
    if (this.pending.length === 0) {
      this.pending = extra.slice();
      return;
    }
    const merged = new Int16Array(this.pending.length + extra.length);
    merged.set(this.pending, 0);
    merged.set(extra, this.pending.length);
    this.pending = merged;
  }

  private ensurePacer(): void {
    if (this.timer !== null || this.closed) return;
    // When the buffer empties we mark the next packet as a talkspurt start so
    // the phone's jitter buffer resets — but we keep the timer running across a
    // single utterance's brief gaps; a tick with <960 samples is simply skipped.
    this.timer = setInterval(() => {
      void this.tick();
    }, PACER_INTERVAL_MS);
  }

  /** Pull one 960-sample frame if available, encode it, emit an RTP packet. */
  private async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    // Buffer fully drained — the talkspurt's audio ended. Re-mark the next real
    // frame as a talkspurt start (so the phone resyncs for the NEXT reply) and
    // re-prime, so the next talkspurt rebuilds its cushion before draining.
    if (this.pending.length === 0) {
      if (this.primed) {
        this.primed = false;
        this.talkspurtStart = true;
      }
      return;
    }
    // Prebuffer: hold off draining a fresh talkspurt until the cushion is built,
    // so jittery TTS bursts can't immediately underrun us. Once primed we drain
    // continuously; a brief sub-frame dip below 960 is simply waited out WITHOUT
    // re-marking a talkspurt — that's what turned a network hiccup into a dropped
    // syllable. Only a true drain-to-empty (above) re-marks.
    if (!this.primed) {
      if (this.pending.length < PREBUFFER_SAMPLES) return; // keep buffering
      this.primed = true;
    }
    if (this.pending.length < OPUS_FRAME_SAMPLES) return; // transient dip; wait
    this.ticking = true;
    try {
      const encoder = await this.getEncoder();
      // Re-check after the await: close() (or buffer drain) may have raced in.
      if (this.closed || this.pending.length < OPUS_FRAME_SAMPLES) return;
      const frame = this.pending.subarray(0, OPUS_FRAME_SAMPLES);
      this.pending = this.pending.slice(OPUS_FRAME_SAMPLES);
      this.emitFrame(encoder, frame);
    } catch (e) {
      // Encoder SETUP failure surfaces here (not silently swallowed): log it.
      // The pacer keeps ticking so a transient failure can recover.
      logger.error(`outbound encode tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Encode a 960-sample frame and hand the built RTP packet to the sink. */
  private emitFrame(encoder: OpusEncoder, frame: Int16Array): void {
    let payload: Uint8Array;
    try {
      payload = encoder.encode(frame);
    } catch (e) {
      // Per-frame encode failure: drop this frame only, keep the stream alive.
      logger.warn(`opus encode dropped a frame: ${(e as Error).message}`);
      return;
    }
    // Defensive guard: DTX is disabled (see getEncoder), so the encoder should
    // always return a real frame — but never emit a 0/1-byte payload as an RTP
    // packet, which would be malformed to the receiver. If a stray empty frame
    // ever appears, skip it: advance the timestamp by the samples consumed (the
    // 48kHz clock stays aligned to wall time) but NOT the sequence number (it
    // counts transmitted packets, so a gap would look like loss), and re-mark
    // the next real frame as a talkspurt start.
    if (encoder.wasDtx() || payload.length <= 2) {
      this.timestamp = (this.timestamp + OPUS_FRAME_SAMPLES) >>> 0;
      this.talkspurtStart = true;
      return;
    }
    const header = new this.rtp.RtpHeader({
      payloadType: OPUS_PAYLOAD_TYPE,
      sequenceNumber: this.sequenceNumber,
      timestamp: this.timestamp,
      ssrc: this.ssrc,
      marker: this.talkspurtStart,
    });
    const packet = new this.rtp.RtpPacket(header, Buffer.from(payload));
    this.talkspurtStart = false;
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    this.timestamp = (this.timestamp + OPUS_FRAME_SAMPLES) >>> 0;
    this.sink(packet);
  }

  private getEncoder(): Promise<OpusEncoder> {
    if (this.encoder) return Promise.resolve(this.encoder);
    // Speech-tuned, loss-resilient encoder: low speech bitrate + inband FEC +
    // an expected-loss hint. DTX is deliberately OFF: discontinuous transmission
    // only saves bandwidth during silence (irrelevant on the tailnet), but it
    // stops the stream on natural micro-pauses and the marker-bit resume forces
    // the phone's jitter buffer to resync — stretching a ~100ms breath into an
    // audible mid-phrase gap. Continuous frames keep cadence smooth. Share one
    // in-flight create across racing ticks.
    return (this.encoderInit ??= createOpusEncoder({
      // 32k (was 24k): headroom so the inband FEC below doesn't starve the
      // primary frame — trivial bandwidth on a tailnet/LAN.
      bitrate: 32000,
      inbandFec: true,
      dtx: false,
      // 25 (was 10): the phone path is WebRTC over Wi-Fi; on-device the reply
      // dropped syllables from packet loss the jitter buffer couldn't hide
      // (2026-06-23, reproduced on both edge-tts and local kokoro → transport,
      // not TTS). A higher expected-loss hint makes Opus carry more FEC so a
      // dropped packet is reconstructed from the next one.
      packetLossPerc: 25,
    }).then((enc) => {
      // close() may have raced in while the encoder was being created.
      if (this.closed) {
        enc.free();
        throw new Error("outbound audio closed during encoder init");
      }
      this.encoder = enc;
      this.encoderInit = null;
      return enc;
    }));
  }
}
