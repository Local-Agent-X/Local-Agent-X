// VoiceBridge — serves the phone's VOICE control plane over the broker peer's `voice`
// data channel instead of the tailnet /ws/voice socket. It is the transport-adapter
// analogue of ChatBridge / HttpTunnelBridge: the AUDIO rides the VoicePeer's media track
// (built by the dialer), and this bridge carries the JSON control plane (hello / ready /
// final / assistant_delta / tts_interrupt / eos / transcript / voice_settings / attach /
// camera / bye). A photo or camera frame is bigger than one data-channel message, so the
// channel is chunked both ways like the chat channel (vendor/chunks.ts ChunkedLink).
//
// It reuses the SAME registered voice-session factory the /ws/voice path uses (the real
// STT→LLM→TTS brain), and the SAME createPeerAudioRouter (TTS-rate snoop + barge-in
// flush) — so broker voice is a second transport in front of one voice brain, not a fork.
//
// Pure over an injected peer getter + session factory, so it unit-tests with a fake
// ControlTransport and a fake session (no werift, no broker socket).

import type { ControlTransport } from "../screen-stream/peer.js";
import type { VoiceAttachment, VoiceSession, VoiceSessionFactory } from "../voice/audio-ws.js";
import { createPeerAudioRouter, type PeerAudioRouter, type PeerAudioSink } from "../voice/voice-peer-session.js";
import { ChunkedLink, parseVoiceControl, type ChatAttachment, type VoiceHelloFrame } from "./vendor/protocol.js";
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

/** The voices a call can speak in, and saving the one the user picks on the phone
 *  (voice/call-voices.ts). Absent in tests and builds without voice settings. */
export interface CallVoices {
  list(): Promise<{ voices: Array<{ id: string; name: string; group: string }>; current: string }>;
  remember(voice: string): Promise<void>;
}

export interface VoiceBridgeDeps {
  /** The VoicePeer (built by the dialer) — outbound TTS audio + barge-in flush. A getter
   *  because the peer + bridge are built together (the peer's onMicPcm calls back here). */
  getPeer: () => PeerAudioSink | null;
  /** The registered voice-session factory (real default = the wired voiceTurnRunner). */
  sessionFactory: VoiceSessionFactory;
  voices?: CallVoices;
}

export class VoiceBridge implements VoiceChannel {
  private transport: ControlTransport | null = null;
  /** The current channel's chunking: one per channel, since the phone behind a new one
   *  may be another build. */
  private link = new ChunkedLink();
  private session: VoiceSession | null = null;
  private readonly router: PeerAudioRouter;
  private closed = false;

  constructor(private readonly deps: VoiceBridgeDeps) {
    this.router = createPeerAudioRouter(deps.getPeer);
  }

  attach(transport: ControlTransport): void {
    if (this.closed) return;
    this.transport = transport; // re-attachable across peer rebuilds (replaces the prior)
    const link = new ChunkedLink();
    this.link = link;
    transport.send(link.hello());
    transport.onMessage((text) => {
      const whole = link.incoming(text); // null: the phone's hello, or part of a frame
      if (whole !== null && this.transport === transport) this.handle(whole);
    });
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
    let frame;
    try {
      frame = parseVoiceControl(JSON.parse(text));
    } catch {
      return; // non-JSON noise on the channel
    }
    switch (frame?.type) {
      case "hello":
        this.onHello(frame);
        break;
      case "eos":
        this.session?.onEndOfSpeech?.();
        break;
      case "transcript":
        this.session?.onTranscript?.(frame.text, frame.isFinal !== false);
        break;
      case "voice_settings":
        this.session?.onVoiceSettings?.({ voice: frame.voice, speed: frame.speed });
        // The user picked this voice on the phone: theirs for every call from now on.
        if (frame.remember === true && frame.voice) void this.deps.voices?.remember(frame.voice);
        break;
      case "attach":
        this.session?.onAttach?.(frame.attachments.flatMap(inlineAttachment));
        break;
      case "camera":
        this.session?.onCameraFrame?.(frame.frame);
        break;
      case "bye":
        this.endSession();
        break;
    }
  }

  /** First `hello` on this channel opens the voice session (mirrors audio-ws.ts). A
   *  second hello (a phone resend) is a no-op so we never double-open. */
  private onHello(hello: VoiceHelloFrame): void {
    const channel = this.transport;
    if (!channel || this.session) return;
    const { sessionId, mode, clientStt } = hello;
    const link = this.link;
    const sendRaw = (event: Record<string, unknown>): void => {
      for (const part of link.outgoing(JSON.stringify(event))) channel.send(part);
    };
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
    // The phone's voice picker: what this call can speak in, and the user's voice now.
    const session = this.session;
    void this.deps.voices?.list().then(
      (offer) => { if (this.session === session) sendRaw({ type: "voices", ...offer }); },
      (e: Error) => logger.warn(`[broker-transport] voice list failed: ${e.message}`),
    );
  }
}

/** A shared attachment with its bytes inline (the parser keeps no other kind). */
function inlineAttachment(a: ChatAttachment): VoiceAttachment[] {
  return a.dataUrl === null ? [] : [{ name: a.name, type: a.type, isImage: a.isImage, dataUrl: a.dataUrl, size: a.size }];
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
