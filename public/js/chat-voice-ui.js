// ── Chat: Voice mode UI helpers ──
//
// renderVoiceEngineBadge — pill near the mic showing which engine is
// active (Lite / Studio / Realtime / browser).
// updateVoiceUI(state) — flips the mic icon class + listening indicator
// based on idle / listening / speaking / error.

function renderVoiceEngineBadge(rt) {
  const el = document.getElementById('voice-engine-badge');
  if (!el) return;
  if (!rt || !rt.engine) { el.style.display = 'none'; el.textContent = ''; el.classList.remove('fellback'); return; }
  const engineLabel = rt.engine === 'tier4' ? 'Tier 4'
    : rt.engine === 'python' ? 'Python sidecar'
    : rt.engine === 'cpu_fallback' ? 'CPU fallback'
    : String(rt.engine);
  const parts = [engineLabel];
  if (rt.tts && rt.tts.device) {
    const dev = String(rt.tts.device).toUpperCase();
    parts.push(dev);
    if (rt.tts.dtype) parts.push(String(rt.tts.dtype));
  }
  if (rt.tts && rt.tts.voice) parts.push('voice: ' + String(rt.tts.voice));
  if (rt.tts && typeof rt.tts.speed === 'number') parts.push(rt.tts.speed + 'x');
  if (rt.stt && rt.stt.model) {
    let whisper = 'whisper ' + String(rt.stt.model);
    if (rt.stt.provider && rt.stt.provider !== 'cpu') whisper += '/' + String(rt.stt.provider);
    parts.push(whisper);
  }
  let fellBack = false;
  if (rt.tts && rt.tts.fellBack) fellBack = true;
  if (rt.stt && rt.stt.fellBack) fellBack = true;
  let label = parts.join(' · ');
  if (fellBack) label += ' (cpu fallback)';
  el.textContent = label;
  el.style.display = 'block';
  el.classList.toggle('fellback', fellBack);
}

function updateVoiceUI(state) {
  const mic = document.getElementById('mic-btn'), ind = document.getElementById('voice-indicator');
  if (!mic) return;
  if (state === 'transcribing') {
    mic.className = 'input-btn listening';
    if (ind) { ind.className = 'listening'; ind.textContent = '⚡ TRANSCRIBING...'; }
    return;
  }
  // Dictate mode: keep mic-btn neutral (the dictate-btn pulses cyan via its
  // own .dictating class). Voice indicator shows DICTATING so the user
  // knows the mic is hot but the agent isn't replying.
  if (dictateMode) {
    mic.className = 'input-btn';
    mic.title = 'Voice mode (currently in dictate — click to switch)';
    if (ind) { ind.className = 'listening'; ind.textContent = '✏ DICTATING'; }
    return;
  }
  if (voiceMode) {
    mic.className = 'input-btn' + (isListening ? ' listening' : (isSpeaking ? ' speaking' : ' listening'));
    mic.title = 'Voice mode ON — click to stop';
    if (ind) {
      if (isListening) { ind.className = 'listening'; ind.textContent = '🎙 LISTENING'; }
      else if (isSpeaking) { ind.className = 'speaking'; ind.textContent = '🔊 SPEAKING'; }
      else { ind.className = 'listening'; ind.textContent = '🎙 VOICE MODE'; }
    }
  } else {
    mic.className = 'input-btn';
    mic.title = 'Click for voice mode (hands-free)';
    if (ind) { ind.className = ''; ind.textContent = ''; }
  }
}
