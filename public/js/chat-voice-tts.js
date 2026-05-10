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
      const s = JSON.parse(localStorage.getItem('sax_settings') || '{}');
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

function _browserSpeak(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  // Pull rate from saved settings so the speed slider in Settings matches.
  try {
    const r = parseFloat(localStorage.getItem('lax_speed') || '1.0');
    if (r > 0.4 && r < 2.5) u.rate = r;
  } catch {}
  const v = _browserResolveVoice();
  if (v) u.voice = v;
  window.speechSynthesis.speak(u);
}
function feedTTS(delta) {
  if (!_browserTtsActive() || !delta) return;
  _browserTtsBuf += delta;
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
  const tail = _browserTtsBuf.trim();
  if (tail) _browserSpeak(tail);
  _browserTtsBuf = "";
}
function stopSpeaking() {
  if (voicePlaybackNode) voicePlaybackNode.port.postMessage({ cmd: 'flush' });
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
  _browserTtsBuf = "";
  isSpeaking = false; updateVoiceUI();
}
function toggleTTS() { toggleMic(); }
function fetchTTSAudio() { return null; } // shim

