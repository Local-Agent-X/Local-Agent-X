// ── Chat: Voice mode (mic streaming) + Dictate mode + Browser TTS ──
//
// Server-side voice pipeline (Python GPU sidecar / Sherpa fallback) with
// browser-side mic capture + audio playback. Dictate mode is the lighter
// "browser SpeechRecognition only" path that drops Whisper transcripts
// into the textarea without firing a full agent reply. Browser-tier TTS
// uses window.speechSynthesis as a no-install fallback.
//
// Owns all voice state (voiceWS, voiceMode, dictate*, browser TTS buffers)
// privately; chat.js and other modules interact via:
//   window.sendVoiceWsMessage(payload)  → wraps voiceWS.send if open
//   isVoiceModeActive()                 → returns whether voice mode is on
//   feedTTS / flushTTS / stopSpeaking   → top-level fns auto-promoted to window
//
// Extracted from chat.js as part of the 400-LOC god-file split.
//
// External deps from chat.js / shared.js / voice-picker.js:
//   - apiFetch, esc, AUTH_TOKEN, API     (shared.js)
//   - addMessageEl, _findStreamingBodyEl (chat.js — auto-window function decls)
//   - window.chatWs                      (chat.js — exposed via Object.defineProperty)
//   - getActiveVoiceTier, voiceFitsTier  (voice-picker.js / catalog)
//   - showVoiceToast                     (chat-voice-modals.js)

// Helper exposed for chat.js's keydown handler to read voiceMode without
// owning the variable. Function decl → automatically becomes window.isVoiceModeActive.
function isVoiceModeActive() { return voiceMode; }

// Same shape as chat.js's window.sendChatWsControl helper but for the voice
// WS. Lets chat-voice-modals.js push voice_settings updates without owning
// the voiceWS reference. Defined here (where voiceWS lives) — chat.js used
// to host this but voiceWS now lives in this module.
window.sendVoiceWsMessage = function(payload) {
  try {
    if (voiceWS && voiceWS.readyState === WebSocket.OPEN) {
      voiceWS.send(JSON.stringify(payload));
      return true;
    }
  } catch {}
  return false;
};

// ── Voice v3: streaming WS to local /ws/voice ──
// Mic frames stream in to the server-side voice session (Python GPU sidecar
// when LAX_VOICE_GPU=1, else in-process Sherpa fallback). Server-side VAD,
// STT, LLM (via voice-llm.ts), and TTS — browser is just transport + UI.
// Replaces the old MediaRecorder + /api/voice/transcribe + /api/voice/synthesize
// REST flow which was slow, blocky, and left the user waiting through full
// utterance buffering before any result.

let voiceMode = false;
let voiceWS = null;
let voiceCtx = null;          // AudioContext (default native rate)
let voiceMicNode = null;
let voicePlaybackNode = null;
let voiceMicStream = null;
let voiceCurrentMsgEl = null;  // assistant chat bubble being built
let voiceCurrentMsgBody = null;
let voiceCurrentMsgText = '';
let _voiceSilenceTimer = null; // sphere → idle if no audio frame for 800ms
// Browser-tier voice chat uses Web Speech API for STT (same as dictate) so the
// "no install" promise actually holds. Server still runs the LLM + TTS, only
// STT moves client-side. voiceSR tracks the recognizer for cleanup.
let voiceSR = null;
let voiceSRRestartGuard = false;
// When true, assistant_delta events feed window.speechSynthesis instead of
// the playback worklet (browser tier — server isn't sending PCM TTS frames).
let voiceBrowserTtsActive = false;
let _voiceBrowserTtsBuf = "";

// Dictate mode is mutually exclusive with voice mode. Uses the browser's
// native SpeechRecognition API (instant-on, native streaming partials, no
// model download, no WebSocket) instead of the full voice-chat pipeline
// which is overkill for one-shot speech-to-text. Mic stream is still
// captured so the sphere visualization can react to audio.
let dictateMode = false;
let dictateSR = null;          // SpeechRecognition instance (browser path)
let dictateMicStream = null;   // MediaStream for sphere analyser only
let dictateCtx = null;         // AudioContext for sphere analyser
let dictateRestartGuard = false; // prevent restart-loop on errors
let dictateRecorder = null;    // MediaRecorder (legacy server-Whisper batch path)
// Target textarea for the current dictation session. Defaults to main chat;
// the IDE composer flips it to 'ide-chat-input' via toggleDictate(id) so
// the same pipeline (mic, SR, Whisper round-trip) routes transcripts to
// whichever composer kicked it off. Single global because dictateMode is
// itself mutually-exclusive — only one composer can dictate at a time.
let dictateTargetId = 'msg-input';

async function toggleMic() {
  if (voiceMode) { stopVoiceMode(); }
  else {
    if (dictateMode) stopDictate();   // mutex: only one mic mode at a time
    await startVoiceMode();
  }
}


// Voice mode: split across modules for the 400-LOC rule.
//   chat-dictate.js           — speech-to-text-only dictate path
//   chat-voice-mic.js         — voice mode start/stop/cleanup
//   chat-voice-ws-handler.js  — voice WS message dispatch
//   chat-voice-tts.js         — browser-fallback TTS (window.speechSynthesis)
//   chat-voice-ui.js          — mic icon + engine badge UI
// All modules share state declared above via the classic-script
// global lexical environment. This file owns the state + entry
// points (toggleMic / isVoiceModeActive / window.sendVoiceWsMessage).

