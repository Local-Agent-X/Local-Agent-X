// Node WebRTC peer (werift) for the desktop side of the bidirectional VOICE
// feature — the audio analogue of screen-stream/peer.ts. Pure-TS: werift has no
// native build step, matching the "zero native build" property the voice opus
// codec (opus-codec.ts) and the screen peer both rely on.
//
// One responsibility: own the RTCPeerConnection + the ONE sendrecv audio
// transceiver. It knows nothing about signaling transport (the session manager
// pumps offer/answer/ICE through these methods), nothing about the STT/TTS
// engines (it hands decoded mic PCM to a callback and accepts TTS PCM through
// writeTtsPcm). That keeps the peer swappable and the seams clean, exactly like
// ScreenPeer.
//
// Direction split vs ScreenPeer: screen is sendonly video; voice is sendrecv
// audio. INBOUND (phone mic) Opus RTP -> decode -> resample to 16kHz -> onMicPcm.
// OUTBOUND (TTS) Int16 PCM -> OutboundAudio (resample 48k, 20ms pace, Opus,
// build RTP) -> the outbound track. Outbound framing lives in voice-rtp-audio.ts
// to stay under the repo's hard 400-LOC-per-file gate.

import type {
  RTCPeerConnection as WeriftPeerConnection,
  MediaStreamTrack as WeriftMediaStreamTrack,
  RTCDataChannel as WeriftDataChannel,
  RTCIceCandidate,
  RtpPacket as WeriftRtpPacket,
} from "werift";
import { createOpusDecoder, resampleInt16, OPUS_SAMPLE_RATE } from "./opus-codec.js";
import type { OpusDecoder } from "./opus-codec.js";
import { OutboundAudio, OPUS_PAYLOAD_TYPE } from "./voice-rtp-audio.js";
// ControlTransport + IceServerConfig are generic WebRTC transport contracts (NOT
// screen-specific logic) — the same seams the http tunnel bridge already reuses
// cross-subsystem. Voice uses them only on the BROKER path (a control data channel +
// broker-minted ICE); the tailnet path passes neither and is byte-for-byte unchanged.
import type { ControlTransport, IceServerConfig } from "../screen-stream/peer.js";
import { createLogger } from "../logger.js";

const logger = createLogger("voice.peer");

/** STT engine sample rate — onMicPcm frames are resampled to this. */
const MIC_SAMPLE_RATE = 16000;

// werift is a heavy WebRTC stack and voice-over-WebRTC is an on-demand feature.
// Load it LAZILY (dynamic import in create()) so it never enters the module
// graph at boot — identical reasoning to screen-stream/peer.ts: a static import
// would make a missing/unbundled werift a fatal ERR_MODULE_NOT_FOUND at startup,
// whereas the lazy import degrades just this feature (the call site catches the
// rejected import). Type-only imports above are erased at compile time.
type WeriftModule = typeof import("werift");
let _weriftPromise: Promise<WeriftModule> | null = null;
function loadWerift(): Promise<WeriftModule> {
  return (_weriftPromise ??= import("werift"));
}

/** Peer connection states forwarded to the signaling machine. */
export type PeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";

/**
 * Trickle ICE candidate wire shape. Mirrors screen-stream's RtcIceCandidate
 * field names (candidate / sdpMid / sdpMLineIndex) so the same mobile signaling
 * code path works for both; defined locally rather than imported from
 * screen-stream/protocol.ts to avoid coupling the voice feature to the screen
 * feature's protocol module (separate subsystems, no shared dependency).
 */
export interface RtcIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export interface VoicePeerHandlers {
  /** A local ICE candidate to trickle to the phone (null = gathering complete). */
  onLocalIce: (candidate: RtcIceCandidate | null) => void;
  /** Peer connection state changed. */
  onConnectionState: (state: PeerState) => void;
  /** A decoded 16kHz mono Int16 PCM frame from the phone's mic. */
  onMicPcm: (frame: Int16Array) => void;
}

/**
 * The desktop voice peer. STUN is OPTIONAL on the tailnet (host candidates
 * connect directly, no NAT) — empty iceServers by default; the operator can add
 * a STUN url via LAX_RTC_STUN. No TURN for the prototype. Mirrors ScreenPeer.
 */
export class VoicePeer {
  private readonly pc: WeriftPeerConnection;
  private readonly outboundTrack: WeriftMediaStreamTrack;
  private readonly outbound: OutboundAudio;
  /** Data channels opened on this peer (the broker path's `voice` control channel).
   *  Empty on the tailnet path. Closed en masse on teardown. */
  private readonly channels: WeriftDataChannel[] = [];
  /** Lazily created on the first inbound RTP packet (a peer with no mic input
   *  never spins up the wasm decoder). */
  private decoder: OpusDecoder | null = null;
  /** In-flight lazy decoder creation, shared across racing inbound packets. */
  private decoderInit: Promise<OpusDecoder> | null = null;
  private closed = false;

  /**
   * Build a peer. Async because werift is imported lazily (see loadWerift) — a
   * missing dep rejects here and is handled by the caller, not at boot.
   *
   * `iceServers` is the broker-minted STUN+TURN config (broker path). Omit it (tailnet
   * path) to fall back to the optional operator LAX_RTC_STUN, unchanged.
   *
   * `onControlReady` opts INTO a `voice` control data channel (broker path): the desktop
   * (offerer) creates it, and once it opens the callback receives a ControlTransport that
   * carries the voice control JSON (hello/ready/final/deltas/eos/…). Omit it (tailnet
   * path) and NO data channel is created — control rides /ws/voice as before.
   */
  static async create(
    handlers: VoicePeerHandlers,
    iceServers?: IceServerConfig[],
    onControlReady?: (transport: ControlTransport) => void,
  ): Promise<VoicePeer> {
    const werift = await loadWerift();
    return new VoicePeer(werift, handlers, iceServers, onControlReady);
  }

  private constructor(
    private readonly werift: WeriftModule,
    private readonly handlers: VoicePeerHandlers,
    iceServers?: IceServerConfig[],
    onControlReady?: (transport: ControlTransport) => void,
  ) {
    const { RTCPeerConnection, MediaStreamTrack, useOPUS } = werift;
    // Broker path supplies the minted ICE list; tailnet leaves it undefined and falls
    // back to the optional operator STUN url (env), as before.
    const stun = process.env.LAX_RTC_STUN?.trim();
    const servers: IceServerConfig[] = iceServers ?? (stun ? [{ urls: stun }] : []);
    this.pc = new RTCPeerConnection({
      // werift's RTCIceServer takes a SINGLE url per entry; the standard/broker shape
      // allows an array, so flatten array `urls` into one entry each.
      iceServers: servers.flatMap(toWeriftIceServers),
      // Advertise standard Opus (48kHz, stereo channel count, dynamic PT 111) so
      // react-native-webrtc on the phone negotiates it as the audio codec.
      codecs: { audio: [useOPUS({ payloadType: OPUS_PAYLOAD_TYPE })] },
    });

    // ONE sendrecv audio transceiver: outbound = our TTS track, inbound = phone mic.
    this.outboundTrack = new MediaStreamTrack({ kind: "audio" });
    this.pc.addTransceiver(this.outboundTrack, { direction: "sendrecv" });

    // Broker path only: open the `voice` control data channel BEFORE the offer so it's
    // negotiated in the SDP. The tailnet path passes no onControlReady → no channel.
    if (onControlReady) this.setupDataChannel("voice", onControlReady);

    this.outbound = new OutboundAudio(
      { RtpPacket: this.werift.RtpPacket, RtpHeader: this.werift.RtpHeader },
      (packet) => {
        if (!this.closed) this.outboundTrack.writeRtp(packet);
      },
    );

    this.pc.onIceCandidate.subscribe((candidate) => {
      if (this.closed) return;
      this.handlers.onLocalIce(candidate ? toIceInit(candidate) : null);
    });
    this.pc.connectionStateChange.subscribe((state) => {
      if (this.closed && state !== "closed") return;
      this.handlers.onConnectionState(state);
    });
    // INBOUND: the phone's mic track arrives via onTrack; subscribe to its RTP.
    this.pc.onTrack.subscribe((track) => {
      if (track.kind !== "audio") return;
      track.onReceiveRtp.subscribe((rtp) => {
        this.handleInboundRtp(rtp);
      });
    });
  }

  /** Create + wire the `voice` control data channel. The desktop is the offerer, so it
   *  CREATES the channel; the transport is surfaced once it opens (send is only valid
   *  then). Mirrors ScreenPeer.setupDataChannel — same duplex-text plumbing. */
  private setupDataChannel(label: string, onReady: (transport: ControlTransport) => void): void {
    const dc = this.pc.createDataChannel(label);
    this.channels.push(dc);
    const transport: ControlTransport = {
      send: (text) => {
        if (this.closed) return;
        try {
          dc.send(text);
        } catch (e) {
          logger.warn(`[voice] control send failed: ${(e as Error).message}`);
        }
      },
      onMessage: (handler) => {
        dc.onMessage.subscribe((data) => handler(typeof data === "string" ? data : data.toString()));
      },
      onClose: (handler) => {
        dc.stateChanged.subscribe((state) => {
          if (state === "closed") handler();
        });
      },
    };
    let surfaced = false;
    dc.stateChanged.subscribe((state) => {
      if (state === "open" && !surfaced) {
        surfaced = true;
        onReady(transport);
      }
    });
  }

  /** Create the SDP offer (after the transceiver is added). Desktop is OFFERER. */
  async createOffer(): Promise<string> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    // The offer carries the canonical, non-undefined sdp — use it directly so we
    // don't have to null-guard the localDescription getter (matches ScreenPeer).
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
   * Push a TTS PCM frame at its engine sample rate. The outbound pacer resamples
   * it to 48kHz, frames it into 20ms Opus packets, and writes them to the track.
   * Non-blocking; the pacer starts on the first call.
   */
  writeTtsPcm(frame: Int16Array, sampleRate: number): void {
    if (this.closed) return;
    this.outbound.push(frame, sampleRate);
  }

  /**
   * Barge-in: drop all outbound TTS PCM still queued in the pacer so the agent
   * goes silent on the phone within ~one frame instead of draining seconds of
   * already-buffered reply audio. The encoder + pacer stay alive, so the next
   * reply streams normally. No-op after close().
   */
  interruptTts(): void {
    if (this.closed) return;
    this.outbound.flush();
  }

  /**
   * Decode one inbound Opus RTP payload -> 48kHz Int16 -> resample to 16kHz ->
   * onMicPcm. The decoder is created lazily on the first packet. Per-packet
   * decode errors drop that packet (the stream self-heals); a decoder SETUP
   * error is surfaced (logged at error level), never silently swallowed.
   */
  private handleInboundRtp(rtp: WeriftRtpPacket): void {
    if (this.closed || rtp.payload.length === 0) return;
    const payload = new Uint8Array(rtp.payload.buffer, rtp.payload.byteOffset, rtp.payload.length);
    void this.getDecoder()
      .then((decoder) => {
        if (this.closed) return;
        let pcm48k: Int16Array;
        try {
          pcm48k = decoder.decode(payload);
        } catch (e) {
          // Bad/partial Opus packet — drop it, keep the stream going.
          logger.warn(`inbound opus decode dropped a packet: ${(e as Error).message}`);
          return;
        }
        if (pcm48k.length === 0) return;
        const pcm16k = resampleInt16(pcm48k, OPUS_SAMPLE_RATE, MIC_SAMPLE_RATE);
        this.handlers.onMicPcm(pcm16k);
      })
      .catch((e: unknown) => {
        // Decoder SETUP failure (not a per-packet error) — surface it.
        logger.error(`inbound decoder unavailable: ${(e as Error).message}`);
      });
  }

  private getDecoder(): Promise<OpusDecoder> {
    if (this.decoder) return Promise.resolve(this.decoder);
    return (this.decoderInit ??= createOpusDecoder().then((dec) => {
      if (this.closed) {
        dec.free();
        throw new Error("voice peer closed during decoder init");
      }
      this.decoder = dec;
      this.decoderInit = null;
      return dec;
    }));
  }

  /** Tear the peer down. Idempotent. Stops the pacer, frees codecs, closes pc. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const dc of this.channels) {
      try {
        dc.close();
      } catch {
        /* already closed */
      }
    }
    this.channels.length = 0;
    this.outbound.close();
    if (this.decoder) {
      this.decoder.free();
      this.decoder = null;
    }
    this.decoderInit = null;
    try {
      this.outboundTrack.stop();
    } catch {
      /* already stopped */
    }
    try {
      await this.pc.close();
    } catch (e) {
      logger.warn(`[voice] peer close threw: ${(e as Error).message}`);
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

/** Expand one IceServerConfig (urls may be an array, standard/broker shape) into the
 *  single-url-per-entry shape werift's RTCIceServer requires. Mirrors the screen peer's
 *  helper; kept local so voice never imports screen internals for an 8-line util. */
function toWeriftIceServers(s: IceServerConfig): { urls: string; username?: string; credential?: string }[] {
  const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
  return urls.map((u) => {
    const entry: { urls: string; username?: string; credential?: string } = { urls: u };
    if (s.username !== undefined) entry.username = s.username;
    if (s.credential !== undefined) entry.credential = s.credential;
    return entry;
  });
}
