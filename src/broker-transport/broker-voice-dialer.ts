// BrokerVoiceDialer — drives a VOICE session over its OWN broker rendezvous (channel=voice),
// a SEPARATE peer from the persistent screen/chat peer: voice gets its own on-demand
// rendezvous + TURN session, so it never renegotiates or collides with the screen peer's
// signaling (see memory apps-over-broker-loopback-proxy / the broker ?channel= change).
//
// The voice payload over the shared BrokerDialer lifecycle:
//   onStart        → build the VoicePeer on the minted ICE + send the offer
//   onAnswer/ice   → peer.applyAnswer / peer.addRemoteIce
//   peer→onLocalIce         → sendIce (drop the end-of-candidates null)
//   peer→onControlTransport → VoiceBridge.attach (the JSON control plane)
//   peer→onMicPcm           → VoiceBridge.onMicFrame (decoded mic → the session's STT)
//   onRebuild      → close the stale peer (KEEP the socket)
//   onTeardown     → close the peer + the bridge
//
// Desktop = OFFERER. Pure over an injected peer factory so it unit-tests with a fake peer +
// a fake session (no werift, no broker socket).

import type { SocketAdapter } from "./vendor/socket-adapter.js";
import { BrokerDialer, type RemoteIceCandidate } from "./broker-dialer.js";
import { VoiceBridge } from "./voice-bridge.js";
import { VoicePeer } from "../voice/voice-peer.js";
import type { RtcIceCandidate, VoicePeerHandlers } from "../voice/voice-peer.js";
import type { VoiceSessionFactory } from "../voice/audio-ws.js";
import type { ControlTransport, IceServerConfig } from "../screen-stream/peer.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.voice-dialer");

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
  /** Fires ONCE when this dialer goes terminal — the voice presence schedules a reconnect. */
  onClosed?: () => void;
}

export class BrokerVoiceDialer extends BrokerDialer {
  private readonly voice: VoiceBridge;
  private readonly createPeer: NonNullable<BrokerVoiceDialerDeps["createPeer"]>;
  private peer: VoicePeerLike | null = null;

  constructor(deps: BrokerVoiceDialerDeps) {
    super({ onClosed: deps.onClosed, logLabel: "voice " });
    this.createPeer = deps.createPeer ?? ((h, ice, onCtrl) => VoicePeer.create(h, ice, onCtrl));
    // The bridge owns the voice control plane + session; getPeer reads the dialer's current
    // peer live (rebuilt on reconnect), so the audio router always targets it.
    this.voice = new VoiceBridge({ getPeer: () => this.peer, sessionFactory: deps.sessionFactory });
    this.wireBroker(deps.socket);
  }

  /** Build the peer + send the offer. The phone DIALING the voice rendezvous IS the
   *  "user tapped mic" trigger. The broker IceServer shape is structurally IceServerConfig. */
  protected async onStart(): Promise<void> {
    const handlers: VoicePeerHandlers = {
      onLocalIce: (candidate) => {
        // null = end-of-candidates; the broker ice signal has no null variant, so we
        // simply stop trickling.
        if (candidate) this.sendIce(candidate);
      },
      onConnectionState: (state) => {
        if (state === "failed") {
          logger.warn("[broker-transport] voice peer failed — tearing down");
          this.teardown();
        }
      },
      onMicPcm: (frame) => this.voice.onMicFrame(frame),
    };
    const peer = await this.createPeer(handlers, this.iceServers, (t) => this.voice.attach(t));
    if (this.stopped) {
      void peer.close();
      return;
    }
    this.peer = peer;
    this.sendOffer(await peer.createOffer());
  }

  protected onAnswer(sdp: string): void {
    void this.peer?.applyAnswer(sdp).catch((e: unknown) =>
      logger.warn(`[broker-transport] voice applyAnswer failed: ${(e as Error).message}`),
    );
  }

  protected onRemoteIce(candidate: RemoteIceCandidate): void {
    void this.peer?.addRemoteIce(candidate).catch((e: unknown) =>
      logger.warn(`[broker-transport] voice addRemoteIce failed: ${(e as Error).message}`),
    );
  }

  /** Drop the stale peer (its data-channel close ends the bridge's session); the next
   *  peer-present rebuilds it on the re-minted ICE. KEEP the socket. */
  protected onRebuild(): void {
    void this.peer?.close();
    this.peer = null;
  }

  protected onTeardown(): void {
    void this.peer?.close();
    this.peer = null;
    this.voice.close();
  }
}
