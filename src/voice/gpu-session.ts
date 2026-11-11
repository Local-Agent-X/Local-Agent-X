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
import { createVoiceTurnMachine, type TurnSpeaker } from "./voice-session/turn-runner.js";
import { createSentenceChunker } from "./voice-session/sentence-chunker.js";
import { registerVoiceSpeaker, unregisterVoiceSpeaker } from "./proactive-registry.js";
import { resolveVoiceSettings } from "./voice-session/settings.js";
import { createBargeInConfirm, createNearFieldGate } from "./voice-session/near-field-gate.js";
import type { VoiceTurnRunner } from "./voice-session/index.js";

import { createLogger } from "../logger.js";
const logger = createLogger("voice.gpu-session");
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
  // Every piece up to this id belongs to a reply that was cancelled. The sidecar acts on
  // a cancel when its loop gets to it, which can be seconds later (it was transcribing
  // the user's barge-in on the GPU the cloned voice was using), and by then it has
  // synthesized and sent those pieces: the user heard the cancelled reply, then the one
  // that replaced it (2026-11-10). So what a cancelled piece sends is dropped here.
  let cancelledThroughId = 0;
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

  // GPU speaker: the reply a sentence at a time (sentence-chunker.ts). Each piece bumps
  // pendingTtsCount; onAudioDone counts it back down and signals the machine when the
  // queue empties.
  // What this reply has said so far is the context the sidecar's Whisper hears the
  // user's next words in (python/voice/_server/models.py _transcribe).
  let queuedThisTurn = false;
  let spokenThisReply = "";
  const chunker = createSentenceChunker((text) => {
    if (!bridge) return;
    pendingTtsCount++;
    bridge.speak(text, nextSentenceId++, { voice: voiceOverride, speed: speedOverride });
    queuedThisTurn = true;
    spokenThisReply = `${spokenThisReply} ${text}`.trim();
    if (!clientStt) bridge.setSttContext(spokenThisReply);
  });
  const speaker: TurnSpeaker = {
    reset() { chunker.reset(); queuedThisTurn = false; spokenThisReply = ""; },
    feed: (delta) => chunker.feed(delta),
    flushTail: () => chunker.flushTail(),
    hasQueued() { return queuedThisTurn; },
    pendingCount() { return pendingTtsCount; },
  };

  const machine = createVoiceTurnMachine({
    ctx,
    runTurn,
    speaker,
    cancelTts: () => {
      cancelledThroughId = nextSentenceId - 1;
      try { bridge?.cancelTTS(); } catch { /* already idle */ }
    },
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
    onAudioChunk: (pcm, sr, id /*, isFinal */) => {
      if (id <= cancelledThroughId) return;
      ctx.sendAudio(pcm);
      machine.noteAudioShipped((pcm.length / (sr || 24000)) * 1000);
    },
    onAudioDone: (sentenceId, _ms, _cancelled) => {
      // A cancelled piece finishing late is not one of the current reply's.
      if (sentenceId <= cancelledThroughId) return;
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
      // `cause` lets the phone offer to start it (agentxos VoiceErrorCause).
      if (!closed) ctx.sendEvent({ type: "voice_error", message: "The voice system on your computer stopped.", cause: "voice-system-off" });
    },
  }, undefined, { stt: !clientStt });

  bridge.ready().catch((e: Error & { code?: string }) => {
    // ECONNREFUSED here means the user opted into GPU voice but hasn't
    // started the Python sidecar — log at info, not error, so it doesn't
    // look like a runtime fault. The UI still gets a clear voice_error
    // event so the user sees what's wrong without digging in server logs.
    if (e.code === "ECONNREFUSED") {
      logger.info(`[gpu-session] ${ctx.sessionId}: GPU sidecar not running on :${process.env.LAX_VOICE_PORT || 7008}`);
      if (!closed) ctx.sendEvent({ type: "voice_error", message: "The voice system on your computer isn't running.", cause: "voice-system-off" });
      return;
    }
    logger.error(`[gpu-session] ${ctx.sessionId}: bridge init failed: ${e.message}`);
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

    onAttach: (attachments) => machine.attach(attachments),
    onCameraFrame: (frame) => machine.setCameraFrame(frame),
    onCameraWatchStop: () => machine.cancelCameraWatch(),

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
