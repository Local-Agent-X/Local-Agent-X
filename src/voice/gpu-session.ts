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

import type { VoiceSession, VoiceSessionContext } from "./audio-ws.js";
import { createGPUBridge, type GPUBridge } from "./gpu-bridge.js";
import { createVoiceTurnMachine, SENTENCE_TERMINATOR, firstChunkCut, type TurnSpeaker } from "./voice-session/turn-runner.js";
import { registerVoiceSpeaker, unregisterVoiceSpeaker } from "./proactive-registry.js";
import { resolveVoiceSettings } from "./voice-session/settings.js";
import { createBargeInConfirm, createNearFieldGate } from "./voice-session/near-field-gate.js";
import type { VoiceTurnRunner } from "./voice-session/index.js";

import { createLogger } from "../logger.js";
const logger = createLogger("voice.gpu-session");
// Long-clause early-flush: if the LLM is grinding out a long comma-heavy
// sentence, fire the first clause to TTS as soon as it's >= ~60 chars and
// has a comma. Cuts time-to-first-audio by 200-500ms on those sentences
// without changing what the listener actually hears (TTS just sees one
// sentence as two clauses).
const CLAUSE_BREAK = /[,;:]\s+/;  // also split on semicolons/colons, not just commas
const CLAUSE_MIN_CHARS = 30;       // was 60; smaller chunks reduce per-sentence synth time so RTF~1 hardware leaves shorter audible gaps

export function createGpuSession(ctx: VoiceSessionContext, runTurn: VoiceTurnRunner): VoiceSession {
  // The phone transcribes on-device (ADR 0010 in agentxos-mobile): its words arrive as
  // `transcript` frames, its mic audio is not ours to transcribe, and the sidecar never
  // loads its STT model for this call. Speaking stays here.
  const clientStt = ctx.clientStt === true;
  let bridge: GPUBridge | null = null;
  let bridgeReady = false;
  let closed = false;
  let pendingTtsCount = 0;
  // True between the sidecar's speech_start and speech_end. Streaming
  // partials outside that window are decoder noise (TTS speaker echo,
  // trailing audio after an endpoint reset) — never a real utterance, since
  // finals come from the sidecar's own endpointed transcription.
  let inUtterance = false;
  let nextSentenceId = 1;
  const pendingFrames: Int16Array[] = [];

  // Background-voice filter, the same one the in-process engine runs: the
  // sidecar's VAD answers "is this speech?", not "is this the person at the
  // mic?", so in a noisy room every nearby talker cut off replies and became a
  // turn. A new utterance interrupts the reply only once enough near-field
  // (loud) audio arrives, and a final whose utterance was far-field (quiet) is
  // dropped. Every voice mode today is the user talking to the agent; a
  // translator mode must not run this, since there the other person's voice
  // is the input.
  //
  // The bar is 20% of the user's level (~14 dB below them), not the in-process
  // engine's 40%: a handheld phone's distance from the mouth swings far more
  // than a desk mic's, and at 40% the user's own "Did you get that?" (0.056
  // against a level of 0.23) was dropped as background (2026-11-03). A talker
  // across the room is ~20 dB below a phone held to the mouth.
  const nearField = createNearFieldGate({ relativeRatio: 0.2 });
  const bargeIn = createBargeInConfirm(nearField);
  const utterance: Int16Array[] = [];
  let utteranceSamples = 0;
  const MAX_UTTERANCE_SAMPLES = 16000 * 30;

  // Per-session voice settings. Initialized from the SERVER-side persisted
  // choice (settings.json ttsVoice) so transports that never send a
  // voice_settings message — the mobile app over the broker — still speak
  // the user's picked voice (e.g. a vx: clone) instead of the sidecar
  // default. Browser sessions override live via the voice_settings WS
  // message as before. Undefined = sidecar env default.
  let voiceOverride: string | undefined;
  let speedOverride: number | undefined;
  try {
    const persisted = resolveVoiceSettings().ttsVoice;
    if (persisted) {
      voiceOverride = persisted;
      logger.info(`[gpu-session] ${ctx.sessionId}: initial voice from settings → ${persisted}`);
    }
  } catch { /* unreadable settings — sidecar default */ }

  // GPU speaker: clause-split long sentences + early-flush the first clause so
  // time-to-first-audio stays low on the sidecar's RTF~1 hardware. Each chunk
  // bumps pendingTtsCount; onAudioDone counts it back down and signals the
  // machine when the queue empties.
  const LONG_SENTENCE_CHARS = 50;
  let sentenceBuf = "";
  let firstClauseFlushed = false;
  let queuedThisTurn = false;
  const speakChunk = (text: string): void => {
    if (!text || !bridge) return;
    pendingTtsCount++;
    bridge.speak(text, nextSentenceId++, { voice: voiceOverride, speed: speedOverride });
    firstClauseFlushed = true;
    queuedThisTurn = true;
  };
  const speakSentence = (raw: string): void => {
    const sentence = raw.trim();
    if (!sentence) return;
    if (sentence.length < LONG_SENTENCE_CHARS) { speakChunk(sentence); return; }
    // Split a long sentence on commas/semicolons so each chunk's synth time
    // stays under the previous chunk's playback time (no audible gap).
    const parts: string[] = [];
    let remaining = sentence;
    while (remaining.length > 0) {
      const m = CLAUSE_BREAK.exec(remaining);
      if (!m || m.index < CLAUSE_MIN_CHARS - 10) break;
      const cut = m.index + m[0].length;
      parts.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut);
    }
    if (remaining.trim()) parts.push(remaining.trim());
    for (const p of parts) speakChunk(p);
  };
  const speaker: TurnSpeaker = {
    reset() { sentenceBuf = ""; firstClauseFlushed = false; queuedThisTurn = false; },
    feed(delta) {
      sentenceBuf += delta;
      // Sentence terminators (.!?) — preferred boundary.
      while (true) {
        const m = SENTENCE_TERMINATOR.exec(sentenceBuf);
        if (!m) break;
        const cutEnd = m.index + m[0].length;
        speakSentence(sentenceBuf.slice(0, cutEnd));
        sentenceBuf = sentenceBuf.slice(cutEnd);
      }
      // First-chunk flush: get the reply's OPENING to TTS as fast as possible
      // so the clone starts reading while the rest still streams — the fix for
      // "voice starts way after the text". Fires once; sentence terminators +
      // speakSentence's clause splitter handle the bulk with better prosody.
      if (!firstClauseFlushed) {
        const cut = firstChunkCut(sentenceBuf);
        if (cut > 0) {
          speakChunk(sentenceBuf.slice(0, cut).trim());
          sentenceBuf = sentenceBuf.slice(cut);
        }
      }
    },
    flushTail() {
      const tail = sentenceBuf.trim();
      if (tail) speakSentence(tail);
      sentenceBuf = "";
    },
    hasQueued() { return queuedThisTurn; },
    pendingCount() { return pendingTtsCount; },
  };

  const machine = createVoiceTurnMachine({
    ctx,
    runTurn,
    speaker,
    cancelTts: () => { try { bridge?.cancelTTS(); } catch { /* already idle */ } },
    isClosed: () => closed,
    logger,
  });
  registerVoiceSpeaker(ctx.sessionId, machine.speakProactive);

  bridge = createGPUBridge({
    onReady: (gpu) => {
      bridgeReady = true;
      ctx.sendEvent({ type: "voice_ready", ttsSampleRate: bridge!.ttsSampleRate, gpu });
      ctx.sendEvent({ type: "stt_model_ready" });
      ctx.sendEvent({ type: "tts_model_ready" });
      ctx.sendEvent({ type: "vad_model_ready" });
      logger.info(`[gpu-session] ${ctx.sessionId}: bridge ready (gpu=${gpu}). draining ${pendingFrames.length} pending frames`);
      while (pendingFrames.length > 0 && !closed && bridge) {
        bridge.feedAudio(pendingFrames.shift()!);
      }
    },
    onSpeechStart: () => {
      inUtterance = true;
      ctx.sendEvent({ type: "vad_speech_start" });
      // Barge-in waits for near-field confirmation (onMicFrame).
      bargeIn.reset();
      utterance.length = 0;
      utteranceSamples = 0;
    },
    onSpeechEnd: () => { inUtterance = false; ctx.sendEvent({ type: "vad_speech_end" }); },
    onPartial: (text) => { if (inUtterance) ctx.sendEvent({ type: "partial", text }); },
    onFinal: (text, ms) => {
      if (utteranceSamples > 0) {
        const pcm = new Int16Array(utteranceSamples);
        let at = 0;
        for (const f of utterance) { pcm.set(f, at); at += f.length; }
        utterance.length = 0;
        utteranceSamples = 0;
        const nf = nearField.accept(pcm);
        logger.info(`[gpu-session] ${ctx.sessionId}: utterance loudness=${nf.loudness.toFixed(4)} floor=${nf.floor.toFixed(4)} ${nf.pass ? "kept" : "dropped"}`);
        if (!nf.pass) {
          logger.info(`[gpu-session] ${ctx.sessionId}: dropped far-field utterance "${text.slice(0, 40)}" (loudness=${nf.loudness.toFixed(4)} < floor=${nf.floor.toFixed(4)})`);
          machine.discardUtterance("far-field utterance");
          return;
        }
      }
      // The machine emits the `final` event (with sttMs) after its guards.
      void machine.handleFinalTranscript(text, ms);
    },
    onAudioChunk: (pcm, sr /*, id, isFinal */) => {
      ctx.sendAudio(pcm);
      machine.noteAudioShipped((pcm.length / (sr || 24000)) * 1000);
    },
    onAudioDone: (_sentenceId, _ms, _cancelled) => {
      pendingTtsCount = Math.max(0, pendingTtsCount - 1);
      // Last chunk drained — the machine's drain signal (it gates on llmDone +
      // an active turn internally and schedules the real end-of-playback).
      if (pendingTtsCount === 0) machine.markTtsDrained();
    },
    onTtsFallback: (from, to, reason) => {
      ctx.sendEvent({ type: "tts_fallback", from, to, reason });
    },
    onSttFallback: (to, reason) => {
      ctx.sendEvent({ type: "stt_fallback", to, reason });
    },
    onError: (message) => {
      ctx.sendEvent({ type: "voice_error", message });
    },
    onDisconnect: () => {
      if (!closed) ctx.sendEvent({ type: "voice_error", message: "GPU sidecar disconnected" });
    },
  }, undefined, { stt: !clientStt });

  bridge.ready().catch((e: Error & { code?: string }) => {
    // ECONNREFUSED here means the user opted into GPU voice but hasn't
    // started the Python sidecar — log at info, not error, so it doesn't
    // look like a runtime fault. The UI still gets a clear voice_error
    // event so the user sees what's wrong without digging in server logs.
    if (e.code === "ECONNREFUSED") {
      logger.info(`[gpu-session] ${ctx.sessionId}: GPU sidecar not running on :${process.env.LAX_VOICE_PORT || 7008}`);
    } else {
      logger.error(`[gpu-session] ${ctx.sessionId}: bridge init failed: ${e.message}`);
    }
    if (!closed) ctx.sendEvent({ type: "voice_error", message: `GPU sidecar unavailable: ${e.message}. Make sure the Python sidecar is running on ${process.env.LAX_VOICE_PORT || 7008}.` });
  });

  return {
    onMicFrame(frame: Int16Array) {
      if (closed || clientStt) return;
      if (!bridgeReady) {
        if (pendingFrames.length < 17) pendingFrames.push(new Int16Array(frame));
        return;
      }
      bridge?.feedAudio(frame);
      if (!inUtterance) return;
      if (utteranceSamples + frame.length <= MAX_UTTERANCE_SAMPLES) {
        utterance.push(new Int16Array(frame));
        utteranceSamples += frame.length;
      }
      if (bargeIn.frame(frame)) {
        // Barge-in (no-op when idle): machine aborts the turn, cancels TTS, tells
        // the client to drop pending audio. Reset our chunk counter so late
        // audio_done callbacks from the killed turn don't bleed into the next.
        machine.interrupt();
        pendingTtsCount = 0;
      }
    },

    onEndOfSpeech() {
      if (!closed && !clientStt) bridge?.flush();
    },

    // The phone's own recognizer (clientStt). It has already dropped background talkers
    // and noise, so a final is the user's words. A non-final frame says the user started
    // talking: that is the barge-in, since the phone's audio no longer reaches us. An
    // empty final is an utterance the phone heard nothing in.
    onTranscript(text: string, isFinal: boolean) {
      if (closed || !clientStt) return;
      const t = text.trim();
      if (!isFinal) {
        machine.interrupt();
        pendingTtsCount = 0;
        if (t) ctx.sendEvent({ type: "partial", text: t });
        return;
      }
      if (!t) {
        machine.discardUtterance("phone heard nothing");
        return;
      }
      void machine.handleFinalTranscript(t);
    },

    onVoiceSettings(settings) {
      if (settings.voice) voiceOverride = settings.voice;
      if (typeof settings.speed === "number" && settings.speed > 0.5 && settings.speed < 2.0) {
        speedOverride = settings.speed;
      }
      logger.info(`[gpu-session] ${ctx.sessionId}: voice settings → voice=${voiceOverride || "(default)"} speed=${speedOverride ?? "(default)"}`);
    },

    close() {
      if (closed) return;
      closed = true;
      unregisterVoiceSpeaker(ctx.sessionId);
      machine.close();
      try { bridge?.close(); } catch {}
      pendingFrames.length = 0;
    },
  };
}
