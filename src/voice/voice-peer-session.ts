// Shared glue between a voice session and a VoicePeer's audio, used by BOTH voice
// transports: the tailnet /ws/voice handler (audio-ws.ts) and the broker voice bridge
// (broker-transport/voice-bridge.ts). Extracted so the two subtle, correctness-critical
// behaviors below live in ONE place and can't drift between transports:
//
//   1. TTS sample rate: writeTtsPcm needs the engine's rate, which the session reports
//      ONCE on the `voice_ready`/`ready`-adjacent event as `ttsSampleRate`. We snoop it
//      off the outbound event stream so outbound audio is paced correctly.
//   2. Barge-in: on `tts_interrupt` the turn machine cancels synthesis, but the desktop
//      synthesizes faster than real-time, so the RTP pacer can still hold seconds of
//      already-encoded reply. Flush it now so the agent goes silent within ~one frame.
//
// Pure over a peer getter (the broker peer is built before this is wired; the WS peer is
// built async after `hello`, so a getter tolerates the not-yet-ready window) + a raw
// event sink (ws.send vs the data channel). No transport, no werift, fully unit-testable.

/** The slice of VoicePeer this router drives — outbound TTS audio + barge-in flush. */
export interface PeerAudioSink {
  writeTtsPcm(frame: Int16Array, sampleRate: number): void;
  interruptTts(): void;
}

export interface PeerAudioRouter {
  /** Route a TTS PCM frame to the peer at the live (snooped) sample rate. */
  sendAudio: (frame: Int16Array) => void;
  /** Wrap a raw control-event sink so it ALSO snoops the TTS rate + flushes on barge-in,
   *  then forwards the event unchanged. The returned fn is the session's `sendEvent`. */
  wrapSendEvent: (raw: (event: Record<string, unknown>) => void) => (event: Record<string, unknown>) => void;
}

/** Default TTS sample rate until the session reports its real one (matches the WebRTC
 *  Opus path's 48kHz default). */
const DEFAULT_TTS_SAMPLE_RATE = 48000;

/**
 * Build the audio router for a VoicePeer. `getPeer` returns the peer (or null while it's
 * still being built — sends are dropped until then, which only happens in the WS path's
 * brief post-hello window; the broker path passes an already-built peer).
 */
export function createPeerAudioRouter(getPeer: () => PeerAudioSink | null): PeerAudioRouter {
  let ttsSampleRate = DEFAULT_TTS_SAMPLE_RATE;
  return {
    sendAudio: (frame) => getPeer()?.writeTtsPcm(frame, ttsSampleRate),
    wrapSendEvent: (raw) => (event) => {
      const r = event["ttsSampleRate"];
      if (typeof r === "number" && r > 0) ttsSampleRate = r;
      if (event["type"] === "tts_interrupt") getPeer()?.interruptTts();
      raw(event);
    },
  };
}
