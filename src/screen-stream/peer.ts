// Node WebRTC peer (werift) for the desktop offerer side of the live-screen
// feature. Pure-TS — werift has no native build step, so it ships without a
// node-gyp toolchain (deliverable §1: "no native build").
//
// One responsibility: own the RTCPeerConnection + the outbound VP8 screen track.
// It knows nothing about ffmpeg (the capture module feeds it RTP via writeRtp)
// and nothing about signaling transport (the session manager pumps offer/answer/
// ICE through these methods). That keeps the peer swappable + the seams clean.

import type {
  RTCPeerConnection as WeriftPeerConnection,
  MediaStreamTrack as WeriftMediaStreamTrack,
  RTCDataChannel as WeriftDataChannel,
  RTCIceCandidate,
} from "werift";
import type { RtcIceCandidate } from "./protocol.js";
import { VP8_PAYLOAD_TYPE, VP8_CLOCK_RATE } from "./ffmpeg-capture.js";
import { createLogger } from "../logger.js";

const logger = createLogger("screen-stream.peer");

// werift is a heavy WebRTC stack and live-screen is an on-demand, unreleased
// feature. Load it LAZILY (dynamic import in `create()`) so it never enters the
// module graph at boot. peer.ts is reachable from the chat-ws import chain, so a
// static `import … from "werift"` makes a missing/unbundled werift a fatal
// ERR_MODULE_NOT_FOUND that takes the whole app down on startup. With the lazy
// import, an absent dep degrades just the screen-stream feature (the call site
// catches the rejected import and reports "couldn't start live screen").
// Type-only imports above are erased at compile time and carry no runtime cost.
type WeriftModule = typeof import("werift");
let _weriftPromise: Promise<WeriftModule> | null = null;
function loadWerift(): Promise<WeriftModule> {
  return (_weriftPromise ??= import("werift"));
}

/** Peer connection states forwarded to the signaling machine. */
export type PeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";

export interface PeerHandlers {
  /** A local ICE candidate to trickle to the phone (null = gathering complete). */
  onLocalIce: (candidate: RtcIceCandidate | null) => void;
  /** Peer connection state changed. */
  onConnectionState: (state: PeerState) => void;
}

/** ICE server config for the RTCPeerConnection — the standard RTCIceServer subset.
 *  STUN entries carry just `urls`; TURN entries also carry a (short-lived)
 *  `username`/`credential`. Structurally identical to the broker's IceServer, so the
 *  broker transport can pass its minted list straight through without this low-level
 *  module importing the broker glue. */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** A duplex text channel for APP CONTROL (remote input + display/focus hints),
 *  carried over the WebRTC data channel in the broker transport. Kept as a minimal
 *  local seam so the broker glue (control-channel.ts) plugs in without this low-level
 *  peer module depending on it. Over the tailnet, control rides /ws/chat instead and
 *  no data channel is created (see `create`'s `onControlReady`). */
export interface ControlTransport {
  send(text: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
}

/** One additional named data channel to open on the broker peer beyond `control`
 *  (e.g. `chat`, `apps`). The desktop (offerer) creates it before the offer so it is
 *  negotiated in the SDP; `onReady` receives a ControlTransport once it opens. This is
 *  how the single broker peer multiplexes screen + chat + apps over one connection. */
export interface DataChannelSpec {
  label: string;
  onReady: (transport: ControlTransport) => void;
}

/**
 * The desktop screen peer. ICE servers depend on the transport:
 * - TAILNET (default): STUN is OPTIONAL (host candidates connect directly, no NAT) —
 *   `create` is called with no iceServers, so we fall back to an empty list or an
 *   operator-supplied LAX_RTC_STUN url. No TURN (constitution §6 / protocol note).
 * - BROKER: the broker mints STUN + short-lived TURN once both peers are gated, and
 *   the dialer passes that list into `create` — the env path is then bypassed.
 */
export class ScreenPeer {
  private readonly pc: WeriftPeerConnection;
  private readonly track: WeriftMediaStreamTrack;
  /** Every data channel opened on this peer (control, plus any extra named channels
   *  like chat/apps in the broker transport). Empty on the tailnet path. Closed en
   *  masse on teardown. */
  private readonly channels: WeriftDataChannel[] = [];
  private closed = false;

  /**
   * Build a peer. Async because werift is imported lazily (see loadWerift) —
   * the dynamic import resolves before any werift value is touched, so a
   * missing dep rejects here and is handled by the caller rather than crashing.
   *
   * `iceServers` is the broker-minted STUN+TURN config (broker transport). When
   * omitted (tailnet path) we fall back to the env LAX_RTC_STUN behavior unchanged.
   *
   * `onControlReady` opts INTO a control data channel (broker transport): the desktop
   * (offerer) creates it, and once it opens, the supplied callback receives a
   * ControlTransport to carry remote input + display/focus hints. Omit it (tailnet
   * path) and NO data channel is created — control rides /ws/chat as before.
   */
  static async create(
    handlers: PeerHandlers,
    iceServers?: IceServerConfig[],
    onControlReady?: (transport: ControlTransport) => void,
    extraChannels?: readonly DataChannelSpec[],
  ): Promise<ScreenPeer> {
    const werift = await loadWerift();
    return new ScreenPeer(werift, handlers, iceServers, onControlReady, extraChannels);
  }

  private constructor(
    private readonly werift: WeriftModule,
    private readonly handlers: PeerHandlers,
    iceServers?: IceServerConfig[],
    onControlReady?: (transport: ControlTransport) => void,
    extraChannels?: readonly DataChannelSpec[],
  ) {
    const { RTCPeerConnection, MediaStreamTrack, useVP8 } = werift;
    // Broker transport supplies the minted ICE list; the tailnet path leaves it
    // undefined and falls back to the optional operator STUN url (env), as before.
    const stun = process.env.LAX_RTC_STUN?.trim();
    const servers: IceServerConfig[] = iceServers ?? (stun ? [{ urls: stun }] : []);
    this.pc = new RTCPeerConnection({
      // werift's RTCIceServer takes a SINGLE url per entry; the standard/broker shape
      // allows an array, so flatten array `urls` into one entry each.
      iceServers: servers.flatMap(toWeriftIceServers),
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

    // Broker transport only: open the control data channel (input + display/focus
    // hints) plus any extra named channels (chat, apps). They MUST be created before
    // createOffer so they are negotiated in the SDP. The tailnet path supplies none.
    if (onControlReady) this.setupDataChannel("control", onControlReady);
    if (extraChannels) for (const ch of extraChannels) this.setupDataChannel(ch.label, ch.onReady);
  }

  /** Create + wire one named data channel. The desktop is the offerer, so it CREATES
   *  the channel; the transport is surfaced once it opens (send is only valid then).
   *  Inbound messages flow through onMessage. Used for `control` and the multiplexed
   *  `chat`/`apps` channels — all duplex text channels with identical plumbing. */
  private setupDataChannel(label: string, onReady: (transport: ControlTransport) => void): void {
    const dc = this.pc.createDataChannel(label);
    this.channels.push(dc);
    const transport: ControlTransport = {
      send: (text) => {
        if (this.closed) return;
        try {
          dc.send(text);
        } catch (e) {
          logger.warn(`[screen-stream] control send failed: ${(e as Error).message}`);
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
      this.track.writeRtp(this.werift.RtpPacket.deSerialize(packet));
    } catch {
      // Malformed/partial datagram — skip it; the stream self-heals on the next.
    }
  }

  /** Tear the peer down. Idempotent. */
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

/** Expand one IceServerConfig (urls may be an array, standard/broker shape) into the
 *  single-url-per-entry shape werift's RTCIceServer requires. Drops absent
 *  username/credential so STUN entries don't carry empty TURN creds. */
function toWeriftIceServers(s: IceServerConfig): { urls: string; username?: string; credential?: string }[] {
  const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
  return urls.map((u) => {
    const entry: { urls: string; username?: string; credential?: string } = { urls: u };
    if (s.username !== undefined) entry.username = s.username;
    if (s.credential !== undefined) entry.credential = s.credential;
    return entry;
  });
}

/** Normalize a werift RTCIceCandidate to the wire shape we send the phone. */
function toIceInit(c: RTCIceCandidate): RtcIceCandidate {
  return {
    candidate: c.candidate ?? "",
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
  };
}
