// Voice session orchestrator. Three streaming pipes + one offline post:
//   mic → VAD + streaming-STT → live partials → LLM → TTS → speaker
//   mic → utterance buffer (on VAD speech-end) → Whisper base.en → final → LLM
// Zipformer is cheap with ~10-12% WER for live partials. Whisper base.en
// (~5% WER) re-transcribes the full utterance on speech-end; that text
// (not the streaming final) is what the agent sees. Barge-in: VAD
// speech-start during an active turn aborts the LLM call, cancels TTS,
// tells the browser to drop pending audio.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
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
import type { VoiceTurnRunner, SecretLookup } from "./types.js";

const logger = createLogger("voice.voice-session");

const SENTENCE_TERMINATOR = /[.!?]["')\]]?(?=\s|$)/;

export function createVoiceSessionFactory(runTurn: VoiceTurnRunner, getSecret: SecretLookup = () => "") {
  return (ctx: VoiceSessionContext): VoiceSession => {
    // Per-session settings resolution — settings.json is the source of
    // truth so a UI dropdown change picks up on the next voice session
    // without restart.
    const voiceSettings = resolveVoiceSettings();

    // OpenAI Realtime full-duplex takes over the whole session when
    // voiceMode=realtime (settings or LAX_VOICE_MODE). Falls through to
    // the normal pipeline if the API key is missing.
    const realtimeWanted = voiceSettings.mode === "realtime" || process.env.LAX_VOICE_MODE === "realtime";
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
    let activeTurn: AbortController | null = null;
    let llmDone = false;
    let ttsQueuedThisTurn = false;
    // Playback-completion estimator. Browser ring buffer holds 1-3s
    // beyond what the worker emitted, so onIdle is too early to clear
    // activeTurn — barge-in would stop while audio is still playing.
    // Track samples-shipped to schedule the real end-of-playback.
    let expectedPlaybackEndMs = 0;
    let pendingClearTimer: NodeJS.Timeout | null = null;
    let ttsSampleRate = 22050;
    const PLAYBACK_TAIL_MS = 250; // grace for browser scheduler / network jitter
    let history: ChatCompletionMessageParam[] = [];
    const pendingFrames: Int16Array[] = [];

    const buffers = createAudioBuffers();

    // Browser tier: client runs SpeechRecognition + speechSynthesis;
    // server-side STT/VAD/Whisper/TTS are dead weight.
    const isBrowserTier = voiceSettings.sttProvider === "browser";

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
            const now = Date.now();
            const chunkMs = (pcm.length / ttsSampleRate) * 1000;
            expectedPlaybackEndMs = Math.max(now, expectedPlaybackEndMs) + chunkMs;
          },
          onIdle: () => {
            if (closed) return;
            ctx.sendEvent({ type: "tts_idle" });
            // Worker done synthesizing, but browser ring still has buffered
            // audio. Schedule activeTurn release at estimated true end.
            if (llmDone && activeTurn) {
              if (pendingClearTimer) clearTimeout(pendingClearTimer);
              const delay = Math.max(0, expectedPlaybackEndMs - Date.now() + PLAYBACK_TAIL_MS);
              pendingClearTimer = setTimeout(() => {
                pendingClearTimer = null;
                if (activeTurn && !closed) {
                  activeTurn = null;
                  llmDone = false;
                  ctx.sendEvent({ type: "playback_complete" });
                }
              }, delay);
            }
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
      // Barge-in: user started talking while the agent was mid-reply.
      if (activeTurn) {
        logger.info(`[voice-session] ${ctx.sessionId}: barge-in detected → interrupting agent`);
        if (pendingClearTimer) { clearTimeout(pendingClearTimer); pendingClearTimer = null; }
        try { activeTurn.abort(); } catch {}
        try { tts?.cancel(); } catch {}
        ctx.sendEvent({ type: "tts_interrupt" });
        activeTurn = null;
        llmDone = false;
        expectedPlaybackEndMs = 0;
      }
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
      whisper.transcribe(audio)
        .then((text) => {
          if (closed) return;
          const t = text.trim();
          if (!t) {
            ctx.sendEvent({ type: "whisper_empty" });
            return;
          }
          handleFinalTranscript(t);
        })
        .catch((e: Error) => {
          logger.warn(`[voice-session] ${ctx.sessionId}: whisper failed: ${e.message}`);
          if (!closed) ctx.sendEvent({ type: "whisper_error", message: e.message });
        });
    }

    async function handleFinalTranscript(utterance: string): Promise<void> {
      if (closed) return;
      if (activeTurn) {
        logger.info(`[voice-session] ${ctx.sessionId}: ignoring final while turn in progress: "${utterance.slice(0, 40)}"`);
        return;
      }

      ctx.sendEvent({ type: "final", text: utterance });

      // Dictate mode: emit the transcript to the client and stop. Skip
      // agent_start / runTurn / TTS — the user only wanted speech-to-text
      // and the client routes `final` into the message textarea. Without
      // this guard the agent would still run server-side and TTS would
      // synthesize a reply the user never asked for.
      if (ctx.mode === "dictate") {
        logger.info(`[voice-session] ${ctx.sessionId}: dictate final, skipping agent/TTS: "${utterance.slice(0, 40)}"`);
        return;
      }

      ctx.sendEvent({ type: "agent_start" });
      activeTurn = new AbortController();
      llmDone = false;
      ttsQueuedThisTurn = false;

      let sentenceBuf = "";
      const flushCompletedSentences = (): void => {
        if (!tts) return;
        while (true) {
          const m = SENTENCE_TERMINATOR.exec(sentenceBuf);
          if (!m) break;
          const cutEnd = m.index + m[0].length;
          const sentence = sentenceBuf.slice(0, cutEnd).trim();
          sentenceBuf = sentenceBuf.slice(cutEnd);
          if (sentence) {
            tts.speak(sentence);
            ttsQueuedThisTurn = true;
          }
        }
      };

      try {
        const result = await runTurn({
          text: utterance,
          history,
          sessionId: ctx.sessionId,
          signal: activeTurn.signal,
          onDelta: (delta) => {
            if (closed || activeTurn?.signal.aborted) return;
            if (!delta) return;
            ctx.sendEvent({ type: "assistant_delta", text: delta });
            sentenceBuf += delta;
            flushCompletedSentences();
          },
          onVisual: (kind, value, durationMs) => {
            if (closed) return;
            ctx.sendEvent({ type: "visual", kind, value, durationMs });
          },
        });

        if (activeTurn?.signal.aborted) {
          // Persist partial history on abort — runTurn catches the abort
          // and returns updatedHistory with an "[interrupted by user]"
          // marker so the next turn has a record of the exchange.
          history = result.updatedHistory;
          ctx.sendEvent({ type: "assistant_interrupted" });
          activeTurn = null;
        } else {
          const tail = sentenceBuf.trim();
          if (tail && tts) {
            tts.speak(tail);
            ttsQueuedThisTurn = true;
          }
          history = result.updatedHistory;
          ctx.sendEvent({ type: "assistant_done", text: result.assistantText });
          // Don't clear activeTurn here — TTS queue may still be draining
          // (LLM often bursts the reply faster than synthesis keeps up).
          // Hold until onIdle so barge-in stays live through playback.
          // Empty/short replies queue nothing → clear immediately since
          // onIdle won't fire.
          if (!ttsQueuedThisTurn) {
            activeTurn = null;
          } else {
            llmDone = true;
          }
        }
      } catch (e) {
        const msg = (e as Error).message || String(e);
        if (activeTurn?.signal.aborted) {
          logger.info(`[voice-session] ${ctx.sessionId}: turn aborted (barge-in)`);
          ctx.sendEvent({ type: "assistant_interrupted" });
        } else {
          logger.warn(`[voice-session] ${ctx.sessionId}: turn failed: ${msg}`);
          ctx.sendEvent({ type: "agent_error", message: msg });
        }
        activeTurn = null;
      }
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
        handleFinalTranscript(t).catch((e) => {
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
        if (pendingClearTimer) { clearTimeout(pendingClearTimer); pendingClearTimer = null; }
        try { activeTurn?.abort(); } catch {}
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
