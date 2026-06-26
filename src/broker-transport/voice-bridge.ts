// VoiceBridge — serves the phone's VOICE control plane over the broker peer's `voice`
// data channel instead of the tailnet /ws/voice socket. It is the transport-adapter
// analogue of ChatBridge / HttpTunnelBridge: the AUDIO rides the VoicePeer's media track
// (built by the dialer), and this bridge carries the JSON control plane (hello / ready /
// final / assistant_delta / tts_interrupt / eos / transcript / voice_settings / bye).
//
// It reuses the SAME registered voice-session factory the /ws/voice path uses (the real
// STT→LLM→TTS brain), and the SAME createPeerAudioRouter (TTS-rate snoop + barge-in
// flush) — so broker voice is a second transport in front of one voice brain, not a fork.
//
// Pure over an injected peer getter + session factory, so it unit-tests with a fake
// ControlTransport and a fake session (no werift, no broker socket).

import type { ControlTransport } from "../screen-stream/peer.js";
import type { VoiceSession, VoiceSessionFactory } from "../voice/audio-ws.js";
import { createPeerAudioRouter, type PeerAudioRouter, type PeerAudioSink } from "../voice/voice-peer-session.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.voice");

/** The voice seam the dialer wires the peer's `voice` channel + decoded mic into.
 *  VoiceBridge is the real impl; NullVoiceChannel drops it (screen/chat-only build). */
export interface VoiceChannel {
  /** Wire the peer's `voice` control data channel once it opens. */
  attach(transport: ControlTransport): void;
  /** Feed one decoded 16kHz mono mic frame from the peer into the live session. */
  onMicFrame(frame: Int16Array): void;
  close(): void;
}

export interface VoiceBridgeDeps {
  /** The VoicePeer (built by the dialer) — outbound TTS audio + barge-in flush. A getter
   *  because the peer + bridge are built together (the peer's onMicPcm calls back here). */
  getPeer: () => PeerAudioSink | null;
  /** The registered voice-session factory (real default = the wired voiceTurnRunner). */
  sessionFactory: VoiceSessionFactory;
}

export class VoiceBridge implements VoiceChannel {
  private transport: ControlTransport | null = null;
  private session: VoiceSession | null = null;
  private readonly router: PeerAudioRouter;
  private closed = false;

  constructor(private readonly deps: VoiceBridgeDeps) {
    this.router = createPeerAudioRouter(deps.getPeer);
  }

  attach(transport: ControlTransport): void {
    if (this.closed) return;
    this.transport = transport; // re-attachable across peer rebuilds (replaces the prior)
    transport.onMessage((text) => this.handle(text));
    transport.onClose(() => {
      // The channel closed (peer rebuilt / phone left) — end the session so a new hello
      // on the next channel starts fresh. Ignore a stale channel's late close.
      if (this.transport === transport) {
        this.transport = null;
        this.endSession();
      }
    });
  }

  onMicFrame(frame: Int16Array): void {
    if (this.closed) return;
    this.session?.onMicFrame(frame);
  }

  close(): void {
    this.closed = true;
    this.endSession();
    this.transport = null;
  }

  private endSession(): void {
    if (!this.session) return;
    try {
      this.session.close();
    } catch (e) {
      logger.warn(`[broker-transport] voice session close threw: ${(e as Error).message}`);
    }
    this.session = null;
  }

  private handle(text: string): void {
    if (this.closed || !this.transport) return;
    let msg: Record<string, unknown>;
    try {
      const raw = JSON.parse(text) as unknown;
      if (typeof raw !== "object" || raw === null) return;
      msg = raw as Record<string, unknown>;
    } catch {
      return; // non-JSON noise on the channel
    }
    switch (msg["type"]) {
      case "hello":
        this.onHello(msg);
        break;
      case "eos":
        this.session?.onEndOfSpeech?.();
        break;
      case "transcript": {
        const t = msg["text"];
        if (typeof t === "string" && t.length > 0) this.session?.onTranscript?.(t, msg["isFinal"] !== false);
        break;
      }
      case "voice_settings":
        this.session?.onVoiceSettings?.({
          voice: typeof msg["voice"] === "string" ? (msg["voice"] as string) : undefined,
          speed: typeof msg["speed"] === "number" ? (msg["speed"] as number) : undefined,
        });
        break;
      case "bye":
        this.endSession();
        break;
      default:
        break; // unknown control frame — ignore
    }
  }

  /** First `hello` on this channel opens the voice session (mirrors audio-ws.ts). A
   *  second hello (a phone resend) is a no-op so we never double-open. */
  private onHello(msg: Record<string, unknown>): void {
    const channel = this.transport;
    if (!channel || this.session) return;
    const sessionId = typeof msg["sessionId"] === "string" ? (msg["sessionId"] as string) : "";
    if (!sessionId) return;
    const mode: "chat" | "dictate" = msg["mode"] === "dictate" ? "dictate" : "chat";
    const clientStt = msg["clientStt"] === true;
    const sendRaw = (event: Record<string, unknown>): void => channel.send(JSON.stringify(event));
    this.session = this.deps.sessionFactory({
      sessionId,
      mode,
      clientStt,
      // Audio rides the media track; the router paces TTS at the snooped engine rate and
      // flushes the RTP pacer on barge-in. Control events ride this data channel.
      sendAudio: this.router.sendAudio,
      sendEvent: this.router.wrapSendEvent(sendRaw),
    });
    sendRaw({ type: "ready", sessionId, mode });
    logger.info(`[broker-transport] voice session opened: ${sessionId} (mode=${mode})`);
  }
}

/** Inert VoiceChannel: voice stays on the tailnet (screen/chat-only broker build / tests). */
export class NullVoiceChannel implements VoiceChannel {
  attach(_transport: ControlTransport): void {
    /* not bridged */
  }
  onMicFrame(_frame: Int16Array): void {
    /* no session */
  }
  close(): void {
    /* nothing to tear down */
  }
}
