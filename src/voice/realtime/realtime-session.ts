// Realtime bridge session.
//
// Drop-in replacement for createGpuSession / createVoiceSessionFactory for
// the LAX_VOICE_MODE=realtime path. Bypasses STT + LLM + TTS entirely:
// browser audio is resampled 16→24kHz and forwarded to OpenAI Realtime,
// model audio comes back at 24kHz and is forwarded to the browser as-is.
//
// Server-side VAD on the OpenAI side handles endpointing + the "stop the
// model when the user starts talking" cancellation. Browser VAD events
// still fire so the existing UI affordances (waveform color, mic ring,
// barge-in flush) keep working — we forward the model's own
// speech_started / speech_stopped through as vad_speech_start / _end.

import type { VoiceSession, VoiceSessionContext } from "../audio-ws.js";
import { createRealtimeClient, DEFAULT_MODEL, DEFAULT_VOICE, VALID_VOICES, type RealtimeClient } from "./openai-realtime-client.js";
import { upsample16to24 } from "./resampler.js";

import { createLogger } from "../../logger.js";
const logger = createLogger("voice.realtime");

export interface RealtimeSessionOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  instructions?: string;
}

const REALTIME_OUTPUT_SR = 24000;

export function createRealtimeSession(opts: RealtimeSessionOptions, ctx: VoiceSessionContext): VoiceSession {
  const model = opts.model || DEFAULT_MODEL;
  const voice = opts.voice && VALID_VOICES.has(opts.voice) ? opts.voice : DEFAULT_VOICE;
  let closed = false;
  let clientReady = false;
  const pendingFrames: Int16Array[] = [];
  let activeResponse = false; // model is currently generating audio

  logger.info(
    `[realtime-session] ${ctx.sessionId}: starting OpenAI Realtime bridge ` +
    `model=${model} voice=${voice} (cost note: ~$5-15/hr per session at current pricing)`,
  );

  let client: RealtimeClient | null = createRealtimeClient(
    {
      apiKey: opts.apiKey,
      model,
      voice,
      instructions: opts.instructions,
    },
    {
      onSessionCreated: () => {
        if (closed) return;
        clientReady = true;
        ctx.sendEvent({
          type: "voice_ready",
          ttsSampleRate: REALTIME_OUTPUT_SR,
          engine: "realtime",
          mode: "realtime",
          model,
          voice,
        });
        // Realtime collapses STT/TTS/VAD into one model — surface ready
        // for each so the existing UI badges flip green.
        ctx.sendEvent({ type: "stt_model_ready" });
        ctx.sendEvent({ type: "tts_model_ready" });
        ctx.sendEvent({ type: "vad_model_ready" });
        // Drain anything the browser sent before the upstream finished
        // its handshake. Frames arrive at 16kHz and need 24kHz upsample.
        while (pendingFrames.length > 0 && !closed && client) {
          const f = pendingFrames.shift()!;
          client.sendAudio(upsample16to24(f));
        }
        logger.info(`[realtime-session] ${ctx.sessionId}: bridge ready, drained ${pendingFrames.length} pending frames`);
      },
      onSpeechStarted: () => {
        if (closed) return;
        // Mirror the existing barge-in pattern — when the upstream model
        // detects user speech mid-reply, cancel its own response and tell
        // the browser to drop its playback ring buffer. (See
        // voice-session.ts handleSpeechStart for the pattern; we don't
        // modify that file, just mimic the events it emits.)
        if (activeResponse) {
          logger.info(`[realtime-session] ${ctx.sessionId}: barge-in → cancelling model response`);
          try { client?.cancelResponse(); } catch {}
          ctx.sendEvent({ type: "tts_interrupt" });
          activeResponse = false;
        }
        ctx.sendEvent({ type: "vad_speech_start" });
      },
      onSpeechStopped: () => {
        if (closed) return;
        ctx.sendEvent({ type: "vad_speech_end" });
      },
      onAudioDelta: (pcm24k) => {
        if (closed) return;
        activeResponse = true;
        // Output is already 24kHz Int16, passthrough straight to browser.
        ctx.sendAudio(pcm24k);
      },
      onTranscriptDelta: (text) => {
        if (closed) return;
        ctx.sendEvent({ type: "assistant_delta", text });
      },
      onResponseDone: () => {
        if (closed) return;
        activeResponse = false;
        ctx.sendEvent({ type: "tts_idle" });
        ctx.sendEvent({ type: "playback_complete" });
      },
      onError: (message) => {
        if (closed) return;
        ctx.sendEvent({ type: "voice_error", message });
      },
      onClose: (code) => {
        if (closed) return;
        ctx.sendEvent({ type: "voice_error", message: `realtime upstream closed (code ${code})` });
      },
    },
  );

  return {
    onMicFrame(frame: Int16Array) {
      if (closed) return;
      if (!clientReady) {
        // Bound the buffer — at 30ms per frame, 17 frames is ~500ms which
        // matches how voice-session.ts sizes its own pending queue.
        if (pendingFrames.length < 17) pendingFrames.push(new Int16Array(frame));
        return;
      }
      client?.sendAudio(upsample16to24(frame));
    },

    onEndOfSpeech() {
      // With server VAD, the model decides when a turn ends. The browser's
      // explicit `eos` is mostly a UI affordance — but if the user mutes
      // mid-utterance we should still nudge the server to commit + reply
      // rather than waiting for the model's own silence detector.
      if (closed || !client) return;
      try { client.commitInput(); client.createResponse(); } catch {}
    },

    onVoiceSettings() {
      // Voice changes mid-session would need session.update; out of scope
      // for v1 (matches how the live voice picker works in voice-session
      // itself — the picker only takes effect on the next session).
    },

    close() {
      if (closed) return;
      closed = true;
      try { client?.close(); } catch {}
      client = null;
      pendingFrames.length = 0;
      logger.info(`[realtime-session] ${ctx.sessionId}: closed`);
    },
  };
}
