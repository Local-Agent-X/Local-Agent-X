// ── Chat: Voice mode UI helpers ──
//
// renderVoiceEngineBadge — pill near the mic showing which engine is
// active (Lite / Studio / Realtime / browser).
// updateVoiceUI(state) — flips the mic icon class + listening indicator
// based on idle / listening / speaking / error.

function renderVoiceEngineBadge(_rt) {
  // Engine badge intentionally hidden — the underlying-engine name (e.g.
  // "Tier 4") doesn't match the user-facing picker tier (Browser / Edge /
  // Studio / Realtime) and was confusing in the chat-bar. The picker UI
  // already shows the active tier; no need to repeat a different label here.
  const el = document.getElementById('voice-engine-badge');
  if (el) { el.style.display = 'none'; el.textContent = ''; el.classList.remove('fellback'); }
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
