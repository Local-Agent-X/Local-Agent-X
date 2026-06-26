// BrokerVoiceDialer — the desktop glue that drives a VOICE session from a SEPARATE broker
// rendezvous (channel=voice) instead of the tailnet /ws/voice socket. It is the voice
// analogue of BrokerScreenDialer, and deliberately a SEPARATE peer from the persistent
// screen/chat peer: voice gets its own on-demand rendezvous + TURN session, so it never
// renegotiates or collides with the screen peer's signaling (see memory
// apps-over-broker-loopback-proxy / the broker ?channel= change).
//
// The mapping (mirrors BrokerScreenDialer):
//   onPeerPresent (+ice-servers/grace) → build the VoicePeer + send the offer
//   onSignal(answer) → peer.applyAnswer   onSignal(ice) → peer.addRemoteIce
//   peer→onLocalIce  → sendSignal(ice)     peer→offer    → sendSignal(offer)
//   peer→onControlTransport → VoiceBridge.attach (the JSON control plane)
//   peer→onMicPcm    → VoiceBridge.onMicFrame (decoded mic → the session's STT)
//   onPeerLeft → rebuild the peer (KEEP the socket)   onClosed/onError → teardown
//
// Desktop = OFFERER (unchanged). Pure over an injected peer factory so it unit-tests with
// a fake peer + a fake session (no werift, no broker socket).

import { BrokerClient } from "./vendor/broker-client.js";
import type { IceServer, RtcSignal } from "./vendor/protocol.js";
import type { SocketAdapter } from "./vendor/socket-adapter.js";
import { VoiceBridge } from "./voice-bridge.js";
import { VoicePeer } from "../voice/voice-peer.js";
import type { RtcIceCandidate, VoicePeerHandlers } from "../voice/voice-peer.js";
import type { VoiceSessionFactory } from "../voice/audio-ws.js";
import type { ControlTransport, IceServerConfig } from "../screen-stream/peer.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.voice-dialer");

/** Same TURN-grace window the screen dialer uses: a TURN-less broker never sends an
 *  ice-servers frame, so we must not wait forever before offering STUN/host-only. */
const ICE_GRACE_MS = 2000;

/** The slice of VoicePeer the dialer drives — lets tests inject a fake peer that records
 *  actions instead of spawning werift. Satisfied by the real VoicePeer. */
export interface VoicePeerLike {
  createOffer(): Promise<string>;
  applyAnswer(sdp: string): Promise<void>;
  addRemoteIce(c: RtcIceCandidate): Promise<void>;
  writeTtsPcm(frame: Int16Array, sampleRate: number): void;
  interruptTts(): void;
  close(): Promise<void>;
}

export interface BrokerVoiceDialerDeps {
  /** A SocketAdapter already opening to the broker connect URL (channel=voice). */
  socket: SocketAdapter;
  /** The registered voice-session factory (the same STT→LLM→TTS brain /ws/voice uses). */
  sessionFactory: VoiceSessionFactory;
  /** Build the peer. Defaults to the real VoicePeer; tests inject a fake. */
  createPeer?: (
    handlers: VoicePeerHandlers,
    iceServers: IceServerConfig[],
    onControlReady: (transport: ControlTransport) => void,
  ) => Promise<VoicePeerLike>;
  /** Fires ONCE when this dialer goes terminal — the voice presence schedules a reconnect.
   *  A dialer is single-use: after this, build a new one. */
  onClosed?: () => void;
}

export class BrokerVoiceDialer {
  private readonly client: BrokerClient;
  private readonly voice: VoiceBridge;
  private readonly createPeer: NonNullable<BrokerVoiceDialerDeps["createPeer"]>;
  private readonly onClosed: (() => void) | undefined;

  private peer: VoicePeerLike | null = null;
  private iceServers: IceServer[] = [];
  private peerPresent = false;
  private started = false;
  private stopped = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: BrokerVoiceDialerDeps) {
    this.onClosed = deps.onClosed;
    this.createPeer = deps.createPeer ?? ((h, ice, onCtrl) => VoicePeer.create(h, ice, onCtrl));
    // The bridge owns the voice control plane + session; getPeer reads the dialer's
    // current peer live (rebuilt on reconnect), so the audio router always targets it.
    this.voice = new VoiceBridge({ getPeer: () => this.peer, sessionFactory: deps.sessionFactory });

    this.client = new BrokerClient(deps.socket, {
      onPeerPresent: () => this.onPeerPresent(),
      onSignal: (signal) => this.onSignal(signal),
      onIceServers: (servers) => this.onIceServers(servers),
      // Phone left (or the broker re-fired our lifecycle on its reconnect): rebuild the
      // peer, KEEP our socket. A dropped OWN socket is onClosed → full teardown.
      onPeerLeft: () => this.prepareRebuild(),
      onClosed: () => this.teardown(),
      onError: (code, message) => {
        logger.warn(`[broker-transport] voice broker error (${code}): ${message}`);
        this.teardown();
      },
    });
  }

  /** Stop the voice session locally (presence shutdown / app exit). Idempotent. */
  stop(): void {
    this.teardown();
  }

  // ── inbound: broker → peer ─────────────────────────────────────────────────────

  private onPeerPresent(): void {
    this.peerPresent = true;
    void this.maybeStart();
    if (!this.started && this.graceTimer === null) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        logger.warn(`[broker-transport] voice: no ice-servers within ${ICE_GRACE_MS}ms — STUN/host-only`);
        void this.maybeStart(true);
      }, ICE_GRACE_MS);
    }
  }

  private onIceServers(servers: IceServer[]): void {
    this.iceServers = servers;
    void this.maybeStart();
  }

  /** Build the peer + send the offer once the phone is present AND we have ICE (or grace
   *  elapsed). The phone DIALING the voice rendezvous IS the "user tapped mic" trigger. */
  private async maybeStart(force = false): Promise<void> {
    if (this.started || this.stopped || !this.peerPresent) return;
    if (this.iceServers.length === 0 && !force) return;
    this.started = true;
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    try {
      const handlers: VoicePeerHandlers = {
        onLocalIce: (candidate) => {
          // null = end-of-candidates; the broker ice signal has no null variant, so we
          // simply stop trickling (matches the screen path).
          if (candidate && !this.stopped) this.client.sendSignal(iceSignal(candidate));
        },
        onConnectionState: (state) => {
          if (state === "failed") {
            logger.warn("[broker-transport] voice peer failed — tearing down");
            this.teardown();
          }
        },
        onMicPcm: (frame) => this.voice.onMicFrame(frame),
      };
      // The broker IceServer shape is structurally the peer's IceServerConfig.
      const peer = await this.createPeer(handlers, this.iceServers, (t) => this.voice.attach(t));
      if (this.stopped) {
        void peer.close();
        return;
      }
      this.peer = peer;
      const sdp = await peer.createOffer();
      if (!this.stopped) this.client.sendSignal({ kind: "offer", sdp });
    } catch (e) {
      logger.error(`[broker-transport] voice peer setup failed: ${(e as Error).message}`);
      this.teardown();
    }
  }

  private onSignal(signal: RtcSignal): void {
    if (this.stopped) return;
    switch (signal.kind) {
      case "answer":
        void this.peer?.applyAnswer(signal.sdp).catch((e: unknown) =>
          logger.warn(`[broker-transport] voice applyAnswer failed: ${(e as Error).message}`),
        );
        break;
      case "ice":
        void this.peer
          ?.addRemoteIce({ candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex })
          .catch((e: unknown) => logger.warn(`[broker-transport] voice addRemoteIce failed: ${(e as Error).message}`));
        break;
      case "offer":
        logger.warn("[broker-transport] ignoring unexpected inbound voice offer (desktop is the offerer)");
        break;
      default: {
        const _exhaustive: never = signal;
        break;
      }
    }
  }

  /** Phone left the voice rendezvous: drop the stale peer (its data-channel close ends the
   *  bridge's session), reset so the next peer-present rebuilds on the re-minted ICE. KEEP
   *  the socket (a dropped socket is the separate onClosed → teardown path). */
  private prepareRebuild(): void {
    if (this.stopped || !this.started) return;
    void this.peer?.close();
    this.peer = null;
    this.started = false;
    this.iceServers = [];
  }

  private teardown(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.client.stop();
    void this.peer?.close();
    this.peer = null;
    this.voice.close();
    this.onClosed?.();
  }
}

/** Map a desktop ICE candidate to the broker's ice signal, coercing the optional
 *  sdpMid/sdpMLineIndex to the explicit `null` the wire contract requires. */
function iceSignal(c: RtcIceCandidate): RtcSignal {
  return { kind: "ice", candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null };
}
