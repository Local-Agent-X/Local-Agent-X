// Node WebRTC peer (werift) for the desktop offerer side of the live-screen
// feature. Pure-TS — werift has no native build step, so it ships without a
// node-gyp toolchain (deliverable §1: "no native build").
//
// One responsibility: own the RTCPeerConnection + the outbound VP8 screen track.
// It knows nothing about ffmpeg (the capture module feeds it RTP via writeRtp)
// and nothing about signaling transport (the session manager pumps offer/answer/
// ICE through these methods). That keeps the peer swappable + the seams clean.

import {
  RTCPeerConnection,
  MediaStreamTrack,
  useVP8,
  RtpPacket,
  type RTCIceCandidate,
} from "werift";
import type { RtcIceCandidate } from "./protocol.js";
import { VP8_PAYLOAD_TYPE, VP8_CLOCK_RATE } from "./ffmpeg-capture.js";
import { createLogger } from "../logger.js";

const logger = createLogger("screen-stream.peer");

/** Peer connection states forwarded to the signaling machine. */
export type PeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";

export interface PeerHandlers {
  /** A local ICE candidate to trickle to the phone (null = gathering complete). */
  onLocalIce: (candidate: RtcIceCandidate | null) => void;
  /** Peer connection state changed. */
  onConnectionState: (state: PeerState) => void;
}

/**
 * The desktop screen peer. STUN is OPTIONAL on the tailnet (host candidates
 * connect directly, no NAT) — we pass an empty iceServers list by default and
 * let the operator add a STUN url via LAX_RTC_STUN if their tailnet topology
 * needs it. No TURN for the prototype (constitution §6 / protocol note).
 */
export class ScreenPeer {
  private readonly pc: RTCPeerConnection;
  private readonly track: MediaStreamTrack;
  private closed = false;

  constructor(private readonly handlers: PeerHandlers) {
    const stun = process.env.LAX_RTC_STUN?.trim();
    this.pc = new RTCPeerConnection({
      iceServers: stun ? [{ urls: stun }] : [],
      // The desktop only SENDS video; advertise VP8 to match the ffmpeg encoder.
      codecs: { video: [useVP8({ payloadType: VP8_PAYLOAD_TYPE, clockRate: VP8_CLOCK_RATE })] },
    });

    this.track = new MediaStreamTrack({ kind: "video" });
    this.pc.addTransceiver(this.track, { direction: "sendonly" });

    this.pc.onIceCandidate.subscribe((candidate) => {
      if (this.closed) return;
      this.handlers.onLocalIce(candidate ? toIceInit(candidate) : null);
    });
    this.pc.connectionStateChange.subscribe((state) => {
      if (this.closed && state !== "closed") return;
      this.handlers.onConnectionState(state);
    });
  }

  /** Create the SDP offer (after the track is added). */
  async createOffer(): Promise<string> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    // setLocalDescription seeds localDescription, but the offer itself already
    // carries the canonical sdp (and is non-undefined) — use it directly so we
    // don't have to null-guard the connection's localDescription getter.
    return offer.sdp;
  }

  /** Apply the phone's SDP answer. */
  async applyAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
  }

  /** Apply a trickled ICE candidate from the phone. */
  async addRemoteIce(candidate: RtcIceCandidate): Promise<void> {
    await this.pc.addIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? undefined,
      sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
    });
  }

  /**
   * Feed one RTP datagram (from ffmpeg) into the outbound track. werift accepts a
   * parsed RtpPacket; we deserialize the wire bytes here so the capture module
   * stays codec-agnostic. Bad packets are dropped, not thrown.
   */
  writeRtp(packet: Buffer): void {
    if (this.closed) return;
    try {
      this.track.writeRtp(RtpPacket.deSerialize(packet));
    } catch {
      // Malformed/partial datagram — skip it; the stream self-heals on the next.
    }
  }

  /** Tear the peer down. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.track.stop();
    } catch {
      /* already stopped */
    }
    try {
      await this.pc.close();
    } catch (e) {
      logger.warn(`[screen-stream] peer close threw: ${(e as Error).message}`);
    }
  }
}

/** Normalize a werift RTCIceCandidate to the wire shape we send the phone. */
function toIceInit(c: RTCIceCandidate): RtcIceCandidate {
  return {
    candidate: c.candidate ?? "",
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
  };
}
