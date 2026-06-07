// Voice session orchestrator. Three streaming pipes + one offline post:
//   mic → VAD + streaming-STT → live partials → LLM → TTS → speaker
//   mic → utterance buffer (on VAD speech-end) → Whisper base.en → final → LLM
// Zipformer is cheap with ~10-12% WER for live partials. Whisper base.en
// (~5% WER) re-transcribes the full utterance on speech-end; that text
// (not the streaming final) is what the agent sees. Barge-in: VAD
// speech-start during an active turn aborts the LLM call, cancels TTS,
// tells the browser to drop pending audio.

import { createLogger } from "../../logger.js";
import type { VoiceSession, VoiceSessionContext } from "../audio-ws.js";
import type { StreamingSTT } from "../stt-stream.js";
import type { StreamingTTS } from "../tts-stream.js";
import type { StreamingVAD } from "../vad-stream.js";
import type { WhisperTranscriber } from "../whisper-stream.js";
import { createGpuSession } from "../gpu-session.js";
import { createRealtimeSessionFromEnv, realtimeReadiness } from "../realtime/index.js";
import type { Tier4StreamingTTS } from "../tier4/types.js";

import { resolveVoiceSettings } from "./settings.js";
import { createAudioBuffers } from "./audio-buffers.js";
import { initializeVoiceStack } from "./model-init.js";
import { createVoiceTurnMachine, SENTENCE_TERMINATOR, type TurnSpeaker } from "./turn-runner.js";
import type { VoiceTurnRunner, SecretLookup } from "./types.js";

const logger = createLogger("voice.voice-session");

export function createVoiceSessionFactory(runTurn: VoiceTurnRunner, getSecret: SecretLookup = () => "") {
  return (ctx: VoiceSessionContext): VoiceSession => {
    // Per-session settings resolution — settings.json is the source of
    // truth so a UI dropdown change picks up on the next voice session
    // without restart.
    const voiceSettings = resolveVoiceSettings();

    // OpenAI Realtime full-duplex is no longer a user-facing voice-chat tier
    // (removed from the media-page picker — it's cloud pay-per-minute and
    // bypasses LAX tools/memory/persona, so it's not the main agent). It stays
    // available as an env-gated capability for phone/meeting-bot use cases.
    // Activation is env-ONLY now: a stale settings.voiceMode="realtime" from
    // before the picker change must NOT silently route main-agent voice to the
    // cloud, so we deliberately ignore voiceSettings.mode here. Settings still
    // supply the voice/model overrides below when env opts in.
    const realtimeWanted = process.env.LAX_VOICE_MODE === "realtime";
    if (realtimeWanted) {
      const ready = realtimeReadiness();
      if (ready.ready) {
        logger.info(`[voice-session] ${ctx.sessionId}: voiceMode=realtime → OpenAI Realtime full-duplex bridge`);
        return createRealtimeSessionFromEnv(ctx, {
          voice: voiceSettings.realtimeVoice,
          model: voiceSettings.realtimeModel,
        });
      }
      logger.warn(`[voice-session] ${ctx.sessionId}: voiceMode=realtime but ${ready.reason || "not ready"} — falling back to normal pipeline`);
    }

    const engine = voiceSettings.engine;
    const TIER4_MODE = engine === "tier4";
    if (engine === "python") {
      logger.info(`[voice-session] ${ctx.sessionId}: engine=python → routing to Python sidecar`);
      return createGpuSession(ctx, runTurn);
    }
    logger.info(`[voice-session] ${ctx.sessionId}: engine=${engine} → in-process${TIER4_MODE ? " (Tier 4 native ONNX Kokoro)" : " (CPU fallback Sherpa+Matcha)"}`);

    let stt: StreamingSTT | null = null;
    let tts: StreamingTTS | null = null;
    let vad: StreamingVAD | null = null;
    let whisper: WhisperTranscriber | null = null;
    let stackReady = false;
    let closed = false;
    let ttsSampleRate = 22050;
    const pendingFrames: Int16Array[] = [];

    const buffers = createAudioBuffers();

    // In-process speaker: stream text to the Tier-4 / CPU TTS worker one whole
    // sentence at a time. The worker emits a single onIdle when its queue
    // drains (ttsCallbacks.onIdle below) — that is the machine's drain signal.
    let sentenceBuf = "";
    let ttsQueued = false;
    const speaker: TurnSpeaker = {
      reset() { sentenceBuf = ""; ttsQueued = false; },
      feed(delta) {
        if (!tts) return;
        sentenceBuf += delta;
        while (true) {
          const m = SENTENCE_TERMINATOR.exec(sentenceBuf);
          if (!m) break;
          const cutEnd = m.index + m[0].length;
          const sentence = sentenceBuf.slice(0, cutEnd).trim();
          sentenceBuf = sentenceBuf.slice(cutEnd);
          if (sentence) { tts.speak(sentence); ttsQueued = true; }
        }
      },
      flushTail() {
        const tail = sentenceBuf.trim();
        if (tail && tts) { tts.speak(tail); ttsQueued = true; }
        sentenceBuf = "";
      },
      hasQueued() { return ttsQueued; },
    };

    const machine = createVoiceTurnMachine({
      ctx,
      runTurn,
      speaker,
      cancelTts: () => { try { tts?.cancel(); } catch { /* already idle */ } },
      isClosed: () => closed,
      logger,
    });

    // Browser tier shortcut: when the client *can* do STT itself (real
    // browser with Web Speech API), we skip the entire server stack —
    // the renderer ships transcripts via the `transcript` message and
    // uses window.speechSynthesis for TTS. Dead weight server-side.
    //
    // Two exceptions where we must NOT take this shortcut:
    //  1. mode=dictate → renderer is always streaming PCM to us (the
    //     dictate path doesn't depend on Web Speech).
    //  2. clientStt === false → Electron-Chromium can't reach Google's
    //     Speech API, so the renderer reports it can't do STT. Run
    //     server-side STT for it. TTS still goes through speechSynthesis
    //     (handled by model-init.ts skipping TTS when tier4Provider=browser).
    const isBrowserTier =
      voiceSettings.sttProvider === "browser"
      && ctx.mode !== "dictate"
      && ctx.clientStt === true;

    (async () => {
      if (isBrowserTier) {
        logger.info(`[voice-session] ${ctx.sessionId}: browser tier → skipping server-side STT/TTS/VAD/Whisper model setup`);
        stackReady = true;
        ctx.sendEvent({ type: "voice_ready", ttsSampleRate: 0, engine, tts: null, stt: { provider: "browser" } });
        return;
      }

      const result = await initializeVoiceStack({
        ctx,
        voiceSettings,
        engine,
        getSecret,
        isClosed: () => closed,
        ttsCallbacks: {
          onAudio: (pcm: Int16Array) => {
            if (closed) return;
            ctx.sendAudio(pcm);
            machine.noteAudioShipped((pcm.length / ttsSampleRate) * 1000);
          },
          onIdle: () => {
            // Worker drained its synth queue — the machine's drain signal.
            if (!closed) machine.markTtsDrained();
          },
          onError: (err: Error) => {
            logger.warn(`[voice-session] ${ctx.sessionId}: tts error: ${err.message}`);
            if (!closed) ctx.sendEvent({ type: "tts_error", message: err.message });
          },
        },
        sttCallbacks: {
          onPartial: (text: string) => { if (!closed) ctx.sendEvent({ type: "partial", text }); },
          onError: (err: Error) => {
            logger.warn(`[voice-session] ${ctx.sessionId}: stt runtime error: ${err.message}`);
            if (!closed) ctx.sendEvent({ type: "stt_error", message: err.message });
          },
        },
        vadCallbacks: {
          onSpeechStart: () => handleSpeechStart(),
          onSpeechEnd: () => handleSpeechEnd(),
          onError: (err: Error) => logger.warn(`[voice-session] ${ctx.sessionId}: vad error: ${err.message}`),
        },
      });

      if (closed || !result) return;
      ({ stt, tts, vad, whisper, ttsSampleRate } = result);

      stackReady = true;
      ctx.sendEvent({
        type: "voice_ready",
        ttsSampleRate,
        engine,
        tts: result.ttsRuntime,
        stt: result.sttRuntime,
      });
      logger.info(`[voice-session] ${ctx.sessionId}: ready — draining ${pendingFrames.length} pending frames`);
      while (pendingFrames.length > 0 && !closed && stt) {
        const f = pendingFrames.shift()!;
        stt.feedAudio(f);
        vad?.feedAudio(f);
      }
    })();

    function handleSpeechStart(): void {
      if (closed) return;
      // Barge-in (no-op when idle): the machine aborts the turn, cancels TTS,
      // and tells the browser to drop pending audio.
      machine.interrupt();
      ctx.sendEvent({ type: "vad_speech_start" });
      buffers.begin();
    }

    function handleSpeechEnd(): void {
      if (closed) return;
      ctx.sendEvent({ type: "vad_speech_end" });
      // Flush Zipformer so the next utterance starts with a clean decoder
      try { stt?.flush(); } catch {}

      const audio = buffers.drain();
      if (audio.length < buffers.MIN_SAMPLES) {
        logger.info(`[voice-session] ${ctx.sessionId}: utterance too short (${audio.length} samples), skipping Whisper`);
        return;
      }
      if (!whisper) return;

      ctx.sendEvent({ type: "whisper_transcribing" });
      const sttStart = Date.now();
      whisper.transcribe(audio)
        .then((text) => {
          if (closed) return;
          const t = text.trim();
          if (!t) {
            ctx.sendEvent({ type: "whisper_empty" });
            return;
          }
          void machine.handleFinalTranscript(t, Date.now() - sttStart);
        })
        .catch((e: Error) => {
          logger.warn(`[voice-session] ${ctx.sessionId}: whisper failed: ${e.message}`);
          if (!closed) ctx.sendEvent({ type: "whisper_error", message: e.message });
        });
    }

    return {
      onMicFrame(frame: Int16Array) {
        if (closed) return;
        // Browser tier: server-side STT disabled, PCM frames are noise.
        if (!stt && !vad) return;
        if (!stackReady) {
          if (pendingFrames.length < 17) pendingFrames.push(new Int16Array(frame));
          return;
        }
        stt?.feedAudio(frame);
        vad?.feedAudio(frame);
        if (buffers.isBuffering) {
          buffers.append(frame);
        } else {
          buffers.pushPreroll(frame);
        }
      },

      onEndOfSpeech() {
        if (!closed && stt) stt.flush();
      },

      onTranscript(text: string, isFinal: boolean) {
        // Browser tier: SpeechRecognition produced this. Skip VAD/Whisper;
        // interims → partial events, finals enter the same path as Whisper.
        if (closed) return;
        const t = text.trim();
        if (!t) return;
        if (!isFinal) {
          ctx.sendEvent({ type: "partial", text: t });
          return;
        }
        machine.handleFinalTranscript(t).catch((e) => {
          logger.warn(`[voice-session] ${ctx.sessionId}: handleFinalTranscript failed: ${(e as Error).message}`);
        });
      },

      onVoiceSettings(settings: { voice?: string; speed?: number }) {
        // Live voice swap from the chat-bar picker. Adapters that pick
        // voice per-utterance (kokoro) handle this via speak() and no-op
        // here; edge-tts and clone-style adapters expose setVoice.
        if (closed) return;
        const v = settings.voice;
        if (!v) return;
        const t4 = tts as unknown as Tier4StreamingTTS;
        if (typeof t4?.setVoice === "function") {
          void t4.setVoice(v).catch((e) => {
            logger.warn(`[voice-session] ${ctx.sessionId}: setVoice failed: ${(e as Error).message}`);
          });
        }
      },

      close() {
        if (closed) return;
        closed = true;
        machine.close();
        try { stt?.close(); } catch {}
        try { tts?.close(); } catch {}
        try { vad?.close(); } catch {}
        try { whisper?.close(); } catch {}
        pendingFrames.length = 0;
        buffers.clear();
      },
    };
  };
}

export type { VoiceTurnInput, VoiceTurnResult, VoiceTurnRunner, SecretLookup } from "./types.js";
export type { VoiceEngineId } from "./settings.js";
