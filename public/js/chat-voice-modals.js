// ── Chat: Voice + Clone Modals ──
//
// Modal builders for: train a new SoVITS voice, add a Chatterbox zero-shot
// voice, manage trained clones. Plus the chat-bar voice picker handler
// (quickSwitchVoice) and the speed slider handler (quickSwitchSpeed) — both
// route through window.sendVoiceWsMessage so this module never holds a
// voiceWS reference. Extracted from chat.js as part of the 400-LOC split.
//
// External deps from chat.js / shared.js:
//   - apiFetch, apiPost, esc, AUTH_TOKEN  (shared.js)
//   - getActiveVoiceTier, switchVoiceTier (voice-picker.js)
//   - window.sendVoiceWsMessage            (chat.js helper)

function quickSwitchVoice(voice) {
  // Tier switcher sentinel — routes to voice-picker.switchVoiceTier(id).
  if (typeof voice === 'string' && voice.startsWith('__tier:')) {
    const tierId = voice.slice('__tier:'.length);
    if (typeof switchVoiceTier === 'function') {
      switchVoiceTier(tierId).then(() => {
        showVoiceToast('Voice system → ' + tierId);
      });
    }
    return;
  }
  if (voice === '__manage_clones__' || voice === '__add_chatterbox__' || voice === '__train_voice__') {
    if (voice === '__add_chatterbox__') openAddChatterboxModal();
    else if (voice === '__train_voice__') openTrainVoiceModal();
    else openManageClonesModal();
    // Reset picker visual to whatever was actually selected before
    const sel = document.getElementById('voice-quick-select');
    if (sel) sel.value = localStorage.getItem('lax_voice') || 'am_michael';
    return;
  }
  localStorage.setItem('lax_voice', voice);
  // Browser-tier TTS uses speechSynthesis directly (no WS). The resolver in
  // _browserResolveVoice reads lax_browser_voice. The settings-page picker
  // writes that key; this chat-bar quick-pick is a parallel path so we need
  // to mirror it here, otherwise picking via the chat bar updates the UI
  // but never affects the actual SpeechSynthesisUtterance.voice.
  let activeTierLocal = null;
  try { activeTierLocal = (typeof getActiveVoiceTier === 'function') ? getActiveVoiceTier() : null; } catch {}
  if (activeTierLocal && activeTierLocal.id === 'browser') {
    try { localStorage.setItem('lax_browser_voice', voice); } catch {}
  }
  const wsState = (typeof voiceWS !== 'undefined' && voiceWS) ? voiceWS.readyState : 'no-ws';
  console.log('[voice] picker → ' + voice + ' (ws=' + wsState + ')');
  if (typeof voiceWS !== 'undefined' && voiceWS && voiceWS.readyState === WebSocket.OPEN) {
    const speed = parseFloat(localStorage.getItem('lax_speed') || '1.15');
    voiceWS.send(JSON.stringify({ type: 'voice_settings', voice, speed }));
    showVoiceToast('Voice → ' + voice + ' (next reply)');
  } else {
    showVoiceToast('Voice → ' + voice + ' (saved; takes effect when mic is on)');
  }
}



// 3 modal builders moved to per-modal files (chat-voice-modal-train/chatterbox/manage.js).

function showVoiceToast(msg) {
  let el = document.getElementById('voice-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'voice-toast';
    el.style.cssText = 'position:fixed;bottom:80px;right:20px;padding:8px 14px;background:#2c3e50;color:#fff;font-size:.82rem;border-radius:6px;z-index:9998;box-shadow:0 4px 12px rgba(0,0,0,.2);transition:opacity .25s';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(window._voiceToastT);
  window._voiceToastT = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}

function quickSwitchSpeed(speed) {
  const s = parseFloat(speed);
  localStorage.setItem('lax_speed', String(s));
  if (typeof voiceWS !== 'undefined' && voiceWS && voiceWS.readyState === WebSocket.OPEN) {
    const voice = localStorage.getItem('lax_voice') || 'am_michael';
    voiceWS.send(JSON.stringify({ type: 'voice_settings', voice, speed: s }));
  }
}
