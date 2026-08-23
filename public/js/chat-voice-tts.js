// ── Chat: Browser-fallback TTS ──
//
// When the user's TTS engine in Settings is "browser", deltas from the
// chat stream are piped into window.speechSynthesis so users without a
// GPU/sidecar can still hear replies. Robotic but no install needed.
// For other engines this module is a no-op (gated by lax_tts_engine in
// localStorage).

// Browser-fallback TTS for text chat. When the user's chosen TTS engine in
// Settings is "browser", we pipe streaming reply deltas into the browser's
// native window.speechSynthesis so users without a GPU/sidecar can still
// hear replies (robotic but free). For any other engine we no-op here —
// voice mode (mic) handles its own TTS via the Lite sidecar WebSocket.
let _browserTtsBuf = "";
function _browserTtsActive() {
  try { return localStorage.getItem('lax_tts_engine') === 'browser'; } catch { return false; }
}

// Voice-picker selection resolver. The picker writes the chosen voice's
// `.name` to lax_browser_voice; we look it up against speechSynthesis's
// async voice list and cache the SpeechSynthesisVoice handle. Cache is
// invalidated on voiceschanged so installing a new system voice or
// flipping locales re-resolves cleanly. Returning null falls back to the
// browser default (matches the picker's "(default browser voice)" option).
let _browserResolvedVoice = null;
let _browserResolvedVoiceName = null;
function _browserResolveVoice() {
  let want = '';
  try { want = localStorage.getItem('lax_browser_voice') || ''; } catch {}
  // Migration: existing users had `voiceTier4Voice` saved server-side before
  // we added the dedicated localStorage key. Fall back to the server-settings
  // mirror so their previous pick keeps working without a re-pick.
  if (!want) {
    try {
      const s = JSON.parse(localStorage.getItem('lax_settings') || '{}');
      if (s.voiceTier4Provider === 'browser' && s.voiceTier4Voice) want = String(s.voiceTier4Voice);
    } catch {}
  }
  if (!want) return null;
  if (_browserResolvedVoiceName === want && _browserResolvedVoice) return _browserResolvedVoice;
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  const match = voices.find(v => v.name === want);
  if (!match) return null;
  _browserResolvedVoice = match;
  _browserResolvedVoiceName = want;
  return match;
}
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  try {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      _browserResolvedVoice = null;
      _browserResolvedVoiceName = null;
    });
  } catch {}
}

// One source of truth for a configured utterance: applies the saved speed
// (matches the Settings slider) and the picked browser voice. Used by both the
// streaming feed (_browserSpeak) and the per-bubble read-aloud button.
function _makeUtterance(text) {
  const u = new SpeechSynthesisUtterance(text);
  try {
    const r = parseFloat(localStorage.getItem('lax_speed') || '1.0');
    if (r > 0.4 && r < 2.5) u.rate = r;
  } catch {}
  const v = _browserResolveVoice();
  if (v) u.voice = v;
  return u;
}
function _browserSpeak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.speak(_makeUtterance(text));
}
function feedTTS(delta) {
  if (!_browserTtsActive() || !delta) return;
  _browserTtsBuf += delta;
  // Strip server-appended history markers before any sentence cut. These
  // are not for the user to hear — they're round-tripped into the next
  // turn's prompt (see server/lifecycle.ts:258). Without this filter the
  // marker ends up in the buffer with no sentence terminator, and flushTTS
  // speaks the whole tool-call dump on stream end.
  _browserTtsBuf = stripSystemMarkers(_browserTtsBuf);
  // Speak whole sentences as they arrive. If the buffer crosses a sentence
  // terminator, slice off and speak that part; keep the tail for next delta.
  const SENT = /[.!?]["')\]]?(\s|$)/g;
  let lastCut = 0;
  let m;
  while ((m = SENT.exec(_browserTtsBuf)) !== null) {
    const sentence = _browserTtsBuf.slice(lastCut, m.index + m[0].length).trim();
    if (sentence) _browserSpeak(sentence);
    lastCut = m.index + m[0].length;
  }
  if (lastCut > 0) _browserTtsBuf = _browserTtsBuf.slice(lastCut);
}
function flushTTS() {
  if (!_browserTtsActive()) { _browserTtsBuf = ""; return; }
  const tail = stripSystemMarkers(_browserTtsBuf).trim();
  if (tail) _browserSpeak(tail);
  _browserTtsBuf = "";
}

// Drop the server's history markers from a string. The trace marker (tool
// call dump) and the interrupted marker are appended to assistant content
// for the next turn's prompt; they aren't spoken content. Once `[Tool calls`
// or `[interrupted by user` appears, everything from there to end-of-string
// is gone — markers are always end-of-turn so there's no after-text to keep.
function stripSystemMarkers(s) {
  if (!s) return s;
  const a = s.indexOf('[Tool calls this turn');
  const b = s.indexOf('[interrupted by user');
  let cut = -1;
  if (a >= 0 && b >= 0) cut = Math.min(a, b);
  else if (a >= 0) cut = a;
  else if (b >= 0) cut = b;
  return cut >= 0 ? s.slice(0, cut) : s;
}
// ── Per-bubble "read aloud" (on-demand) ──
//
// Backs the 🔊 button on each finalized assistant bubble
// (chat-render.appendReadAloudBtn). Unlike feedTTS — which is gated to the
// "browser" streaming-TTS engine — this ALWAYS speaks: the user explicitly
// asked to hear THIS message, via window.speechSynthesis (the one path needing
// no GPU/sidecar). Clicking the active button, or any other bubble's button,
// stops the current playback. Long replies are chunked by sentence so the
// browser's per-utterance length cap can't truncate them.
let _readAloudBtn = null;
function _setReadAloudState(btn, on) {
  if (!btn) return;
  btn.classList.toggle('speaking', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Stop reading' : 'Read aloud';
  btn.textContent = on ? '⏹' : '🔊';
}
function speakBubble(btn, bodyEl) {
  if (!('speechSynthesis' in window)) return;
  const toggleOff = _readAloudBtn === btn && window.speechSynthesis.speaking;
  const prev = _readAloudBtn;
  // Null FIRST so any in-flight speakNext loop (fired via onend after cancel)
  // sees it's superseded and stops instead of advancing.
  _readAloudBtn = null;
  try { window.speechSynthesis.cancel(); } catch {}
  if (prev && prev !== btn) _setReadAloudState(prev, false);
  if (toggleOff) { _setReadAloudState(btn, false); return; }
  const text = stripSystemMarkers((bodyEl && bodyEl.textContent) || '').trim();
  if (!text) return;
  _readAloudBtn = btn;
  _setReadAloudState(btn, true);
  const parts = text.match(/[^.!?]+[.!?]+(?=\s|$)|\S[^.!?]*$/g) || [text];
  let i = 0;
  const speakNext = () => {
    if (_readAloudBtn !== btn) return;                       // superseded / stopped
    if (i >= parts.length) { _setReadAloudState(btn, false); _readAloudBtn = null; return; }
    const u = _makeUtterance(parts[i++].trim());
    u.onend = speakNext;
    u.onerror = () => { if (_readAloudBtn === btn) { _setReadAloudState(btn, false); _readAloudBtn = null; } };
    window.speechSynthesis.speak(u);
  };
  speakNext();
}
if (typeof window !== 'undefined') window.speakBubble = speakBubble;

function stopSpeaking() {
  if (voicePlaybackNode) voicePlaybackNode.port.postMessage({ cmd: 'flush' });
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
  // Also clear any per-bubble read-aloud in flight so its button resets.
  if (_readAloudBtn) { _setReadAloudState(_readAloudBtn, false); _readAloudBtn = null; }
  _browserTtsBuf = "";
  isSpeaking = false; updateVoiceUI();
}
function toggleTTS() { toggleMic(); }
function fetchTTSAudio() { return null; } // shim

