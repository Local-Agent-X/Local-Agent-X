// GPU-mode voice session.
//
// All speech work (VAD + STT + TTS) happens in the Python sidecar; this
// module is a thin orchestrator that wires the bridge's events to the
// browser-facing WS events and runs the LLM turn between final transcript
// and first TTS sentence.
//
// The CPU-mode createVoiceSessionFactory in voice-session.ts dispatches
// here when LAX_VOICE_GPU=1. Both modes implement the same VoiceSession
// shape, so audio-ws.ts doesn't need to know which path is active.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { VoiceSession, VoiceSessionContext } from "./audio-ws.js";
import { createGPUBridge, type GPUBridge } from "./gpu-bridge.js";
import type { VoiceTurnRunner } from "./voice-session.js";

const SENTENCE_TERMINATOR = /[.!?]["')\]]?(?=\s|$)/;
// Long-clause early-flush: if the LLM is grinding out a long comma-heavy
// sentence, fire the first clause to TTS as soon as it's >= ~60 chars and
// has a comma. Cuts time-to-first-audio by 200-500ms on those sentences
// without changing what the listener actually hears (TTS just sees one
// sentence as two clauses).
const CLAUSE_BREAK = /,\s+/;
const CLAUSE_MIN_CHARS = 60;

export function createGpuSession(ctx: VoiceSessionContext, runTurn: VoiceTurnRunner): VoiceSession {
  let bridge: GPUBridge | null = null;
  let bridgeReady = false;
  let closed = false;
  let activeTurn: AbortController | null = null;
  let llmDone = false;
  let pendingTtsCount = 0;
  let nextSentenceId = 1;
  let history: ChatCompletionMessageParam[] = [];
  const pendingFrames: Int16Array[] = [];

  // Playback-end estimator. The bridge's onAudioDone fires when the
  // sidecar finishes shipping audio chunks, but the browser still has
  // ~1-3sec of audio buffered in its playback ring. If we clear
  // activeTurn at audio_done, barge-in stops working during that tail.
  // Tracking samples-shipped + a constant rate lets us schedule the
  // real end-of-playback.
  let expectedPlaybackEndMs = 0;
  let pendingClearTimer: NodeJS.Timeout | null = null;
  const PLAYBACK_TAIL_MS = 250; // grace for browser scheduler / network jitter

  // Per-session voice settings, controlled live by the browser via the
  // voice_settings WS message. Undefined = use sidecar's env defaults.
  let voiceOverride: string | undefined;
  let speedOverride: number | undefined;

  bridge = createGPUBridge({
    onReady: (gpu) => {
      bridgeReady = true;
      ctx.sendEvent({ type: "voice_ready", ttsSampleRate: bridge!.ttsSampleRate, gpu });
      ctx.sendEvent({ type: "stt_model_ready" });
      ctx.sendEvent({ type: "tts_model_ready" });
      ctx.sendEvent({ type: "vad_model_ready" });
      console.log(`[gpu-session] ${ctx.sessionId}: bridge ready (gpu=${gpu}). draining ${pendingFrames.length} pending frames`);
      while (pendingFrames.length > 0 && !closed && bridge) {
        bridge.feedAudio(pendingFrames.shift()!);
      }
    },
    onSpeechStart: () => {
      ctx.sendEvent({ type: "vad_speech_start" });
      // Barge-in: user started talking while agent was replying
      if (activeTurn) {
        console.log(`[gpu-session] ${ctx.sessionId}: barge-in → interrupting agent`);
        if (pendingClearTimer) { clearTimeout(pendingClearTimer); pendingClearTimer = null; }
        try { activeTurn.abort(); } catch {}
        try { bridge?.cancelTTS(); } catch {}
        ctx.sendEvent({ type: "tts_interrupt" });
        activeTurn = null;
        llmDone = false;
        pendingTtsCount = 0;
        expectedPlaybackEndMs = 0;
      }
    },
    onSpeechEnd: () => { ctx.sendEvent({ type: "vad_speech_end" }); },
    onPartial: (text) => { ctx.sendEvent({ type: "partial", text }); },
    onFinal: (text, ms) => {
      ctx.sendEvent({ type: "final", text, sttMs: ms });
      handleFinalTranscript(text);
    },
    onAudioChunk: (pcm, sr /*, id, isFinal */) => {
      ctx.sendAudio(pcm);
      // Push expected end-of-playback forward by this chunk's duration.
      // Sample count / sample rate gives playback duration in seconds.
      const now = Date.now();
      const chunkMs = (pcm.length / (sr || 24000)) * 1000;
      expectedPlaybackEndMs = Math.max(now, expectedPlaybackEndMs) + chunkMs;
    },
    onAudioDone: (_sentenceId, _ms, _cancelled) => {
      pendingTtsCount = Math.max(0, pendingTtsCount - 1);
      if (llmDone && pendingTtsCount === 0 && activeTurn) {
        ctx.sendEvent({ type: "tts_idle" });
        // Sidecar drained its TTS queue, but the browser ring still has
        // buffered audio. Schedule activeTurn release at the estimated
        // true end-of-playback so barge-in keeps working.
        if (pendingClearTimer) clearTimeout(pendingClearTimer);
        const delay = Math.max(0, expectedPlaybackEndMs - Date.now() + PLAYBACK_TAIL_MS);
        pendingClearTimer = setTimeout(() => {
          pendingClearTimer = null;
          if (activeTurn && !closed) {
            activeTurn = null;
            llmDone = false;
            expectedPlaybackEndMs = 0;
            ctx.sendEvent({ type: "playback_complete" });
          }
        }, delay);
      }
    },
    onError: (message) => {
      ctx.sendEvent({ type: "voice_error", message });
    },
    onDisconnect: () => {
      if (!closed) ctx.sendEvent({ type: "voice_error", message: "GPU sidecar disconnected" });
    },
  });

  bridge.ready().catch((e: Error) => {
    console.error(`[gpu-session] ${ctx.sessionId}: bridge init failed: ${e.message}`);
    if (!closed) ctx.sendEvent({ type: "voice_error", message: `GPU sidecar unavailable: ${e.message}. Make sure the Python sidecar is running on ${process.env.LAX_VOICE_PORT || 7008}.` });
  });

  async function handleFinalTranscript(rawText: string): Promise<void> {
    if (closed) return;
    const utterance = rawText.trim();
    if (!utterance) return;
    if (activeTurn) {
      console.log(`[gpu-session] ${ctx.sessionId}: ignoring final while turn in progress`);
      return;
    }

    ctx.sendEvent({ type: "agent_start" });
    activeTurn = new AbortController();
    llmDone = false;
    pendingTtsCount = 0;

    let sentenceBuf = "";
    let firstClauseFlushed = false;  // only flush the early clause once per turn
    const flushSentences = (): void => {
      // Sentence terminators (.!?) — preferred boundary
      while (true) {
        const m = SENTENCE_TERMINATOR.exec(sentenceBuf);
        if (!m) break;
        const cutEnd = m.index + m[0].length;
        const sentence = sentenceBuf.slice(0, cutEnd).trim();
        sentenceBuf = sentenceBuf.slice(cutEnd);
        if (sentence && bridge) {
          pendingTtsCount++;
          bridge.speak(sentence, nextSentenceId++, { voice: voiceOverride, speed: speedOverride });
          firstClauseFlushed = true;
        }
      }
      // Early clause flush: if no period yet but the buffer is long and
      // has a comma break, emit the first clause so TTS can start sooner.
      // Only do this for the FIRST clause of a turn — after that we'd
      // rather wait for full sentences so prosody stays natural.
      if (!firstClauseFlushed && sentenceBuf.length >= CLAUSE_MIN_CHARS) {
        const m = CLAUSE_BREAK.exec(sentenceBuf);
        if (m && m.index >= CLAUSE_MIN_CHARS - 10) {
          const cutEnd = m.index + m[0].length;
          const clause = sentenceBuf.slice(0, cutEnd).trim();
          sentenceBuf = sentenceBuf.slice(cutEnd);
          if (clause && bridge) {
            pendingTtsCount++;
            bridge.speak(clause, nextSentenceId++, { voice: voiceOverride, speed: speedOverride });
            firstClauseFlushed = true;
          }
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
          if (closed || activeTurn?.signal.aborted || !delta) return;
          ctx.sendEvent({ type: "assistant_delta", text: delta });
          sentenceBuf += delta;
          flushSentences();
        },
      });

      if (activeTurn?.signal.aborted) {
        ctx.sendEvent({ type: "assistant_interrupted" });
        activeTurn = null;
        return;
      }

      const tail = sentenceBuf.trim();
      if (tail && bridge) {
        pendingTtsCount++;
        bridge.speak(tail, nextSentenceId++, { voice: voiceOverride, speed: speedOverride });
      }
      history = result.updatedHistory;
      ctx.sendEvent({ type: "assistant_done", text: result.assistantText });
      llmDone = true;
      // If TTS already drained while LLM was still streaming (rare but
      // possible for very short replies), close the turn now.
      if (pendingTtsCount === 0) {
        ctx.sendEvent({ type: "tts_idle" });
        ctx.sendEvent({ type: "playback_complete" });
        activeTurn = null;
        llmDone = false;
      }
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (activeTurn?.signal.aborted) {
        console.log(`[gpu-session] ${ctx.sessionId}: turn aborted (barge-in)`);
        ctx.sendEvent({ type: "assistant_interrupted" });
      } else {
        console.warn(`[gpu-session] ${ctx.sessionId}: turn failed: ${msg}`);
        ctx.sendEvent({ type: "agent_error", message: msg });
      }
      activeTurn = null;
    }
  }

  return {
    onMicFrame(frame: Int16Array) {
      if (closed) return;
      if (!bridgeReady) {
        if (pendingFrames.length < 17) pendingFrames.push(new Int16Array(frame));
        return;
      }
      bridge?.feedAudio(frame);
    },

    onEndOfSpeech() {
      if (!closed) bridge?.flush();
    },

    onVoiceSettings(settings) {
      if (settings.voice) voiceOverride = settings.voice;
      if (typeof settings.speed === "number" && settings.speed > 0.5 && settings.speed < 2.0) {
        speedOverride = settings.speed;
      }
      console.log(`[gpu-session] ${ctx.sessionId}: voice settings → voice=${voiceOverride || "(default)"} speed=${speedOverride ?? "(default)"}`);
    },

    close() {
      if (closed) return;
      closed = true;
      if (pendingClearTimer) { clearTimeout(pendingClearTimer); pendingClearTimer = null; }
      try { activeTurn?.abort(); } catch {}
      try { bridge?.close(); } catch {}
      pendingFrames.length = 0;
    },
  };
}
