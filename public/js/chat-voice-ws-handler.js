// ── Chat: Voice WS message handler ──
//
// Per-event-type dispatch for the voice WS feed:
//   vad_speech_start / vad_speech_end → sphere state + mic indicator
//   transcription_partial / transcription_final → input echo / agent submit
//   agent_start / agent_delta / agent_done → assistant bubble streaming
//   tts_pcm / tts_done → playback worklet feed
//   error → toast + state reset
//
// Split out of chat-voice-mic.js so each file stays under 400 LOC. State
// lives in chat-voice.js (shared script-global lexical env).

function handleVoiceWsMessage(e) {
  // Binary frames are TTS PCM — pipe to playback worklet
  if (typeof e.data !== 'string') {
    if (voicePlaybackNode) voicePlaybackNode.port.postMessage({ cmd: 'pcm', pcm: e.data });
    // First audio frame of a turn = the moment Optimus actually starts
    // talking. Switch the sphere to 'speaking' here, NOT on agent_start
    // (which fires when text streaming begins, before any audio reaches
    // the speaker). Reset the silence watchdog every frame; when it expires
    // we know audio playback has actually finished.
    if (window.VoiceSphere && VoiceSphere.currentState !== 'speaking') {
      VoiceSphere.setState('speaking');
    }
    if (_voiceSilenceTimer) clearTimeout(_voiceSilenceTimer);
    _voiceSilenceTimer = setTimeout(() => {
      if (window.VoiceSphere && VoiceSphere.currentState === 'speaking') {
        VoiceSphere.setState('idle');
      }
    }, 800);
    return;
  }
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }

  switch (msg.type) {
    case 'voice_ready':
      if (voicePlaybackNode && msg.ttsSampleRate) {
        voicePlaybackNode.port.postMessage({ cmd: 'setRate', rate: msg.ttsSampleRate });
      }
      window.LAX_VOICE_RUNTIME = { engine: msg.engine || null, tts: msg.tts || null, stt: msg.stt || null };
      try { renderVoiceEngineBadge(window.LAX_VOICE_RUNTIME); } catch (badgeErr) { console.warn('[voice] badge render failed:', badgeErr); }
      break;
    case 'vad_speech_start':
      // Drop any orphaned live-partial bubble from a prior utterance that never
      // got a `final` (e.g. an empty/rejected transcript) before this one builds.
      if (!dictateMode && voicePartialEl) { try { voicePartialEl.remove(); } catch {} voicePartialEl = null; }
      isListening = true; updateVoiceUI();
      window.VoiceSphere && VoiceSphere.setState('listening'); break;
    case 'vad_speech_end':   isListening = false; updateVoiceUI();
      window.VoiceSphere && VoiceSphere.setState('thinking'); break;
    case 'final': {
      if (!msg.text) break;
      // Dictate mode: route Whisper finals into the message textarea instead
      // of the chat thread. User reviews + sends manually.
      if (dictateMode) {
        appendDictatedText(msg.text);
        break;
      }
      // Voice mode: commit the user's utterance into the thread. If a live
      // partial bubble is already on screen (streamed from Sherpa partials),
      // finalize it in place with the corrected Whisper text — no flash of a
      // second bubble. Otherwise create it now. The agent turn is triggered
      // server-side off this same final either way; the preview just makes the
      // STT wait feel responsive instead of dead-air.
      const empty = document.getElementById('empty');
      if (empty) empty.remove();
      let userEl = voicePartialEl;
      if (userEl) {
        userEl.classList.remove('voice-partial');
        const body = userEl.querySelector('.msg-body');
        if (body) body.textContent = msg.text;
        voicePartialEl = null;
      } else if (typeof addMessageEl === 'function') {
        userEl = addMessageEl('user', msg.text);
      }
      // Pin the just-spoken utterance near the top so it stays readable — the
      // user checks here whether their speech transcribed correctly. The reply
      // streams (and is spoken) below it instead of autoscroll shoving the
      // utterance off the top.
      if (userEl && typeof userEl.scrollIntoView === 'function') {
        userEl.scrollIntoView({ block: 'start' });
      }
      if (typeof activeChat !== 'undefined' && activeChat) {
        activeChat.messages.push({ role: 'user', content: msg.text });
        activeChat.updatedAt = Date.now();
      }
      break;
    }
    case 'partial': {
      if (!msg.text) break;
      // Dictate mode: ghost preview row below the textarea; `final` commits it
      // to the textarea.
      if (dictateMode) {
        const preview = document.getElementById('dictate-preview');
        if (preview) {
          preview.textContent = msg.text;
          preview.style.display = 'block';
        }
        break;
      }
      // Voice mode: live transcription preview. Stream the recognized words
      // into a dimmed user bubble so the wait for the final Whisper commit
      // feels responsive (masks STT latency — it does NOT change when the agent
      // turn fires; that's still server-side off the `final`). The bubble is
      // finalized in place by the `final` case, or dropped on the next
      // vad_speech_start if no final arrives.
      const empty = document.getElementById('empty');
      if (empty) empty.remove();
      if (!voicePartialEl) {
        if (typeof addMessageEl !== 'function') break;
        voicePartialEl = addMessageEl('user', msg.text);
        if (voicePartialEl) {
          voicePartialEl.classList.add('voice-partial');
          if (typeof voicePartialEl.scrollIntoView === 'function') {
            voicePartialEl.scrollIntoView({ block: 'start' });
          }
        }
      } else {
        const body = voicePartialEl.querySelector('.msg-body');
        if (body) body.textContent = msg.text;
      }
      break;
    }
    case 'agent_start': {
      // Dictate mode: agent should never run, but if a stale server still
      // tries to start a turn, just drop the events instead of injecting
      // a phantom assistant bubble into the chat thread.
      if (dictateMode) break;
      if (typeof addMessageEl === 'function') {
        voiceCurrentMsgEl = addMessageEl('assistant', '');
        voiceCurrentMsgBody = voiceCurrentMsgEl?.querySelector('.msg-body');
        if (voiceCurrentMsgBody) voiceCurrentMsgBody.innerHTML = thinkingHTML();
      }
      voiceCurrentMsgText = '';
      isSpeaking = true; updateVoiceUI();
      // Sphere stays in 'thinking' here — it transitions to 'speaking' when
      // the first audio frame actually arrives at the playback worklet,
      // which is when the user hears anything (clone synth + sentence
      // buffering adds lag after text starts streaming).
      break;
    }
    case 'assistant_delta':
      if (!voiceCurrentMsgBody) break;
      voiceCurrentMsgText += msg.text || '';
      // Plain text, not markdown re-parsed every token: voice replies are
      // spoken conversational text, and re-rendering the whole block per delta
      // was the on-screen jitter. No autoscroll-to-bottom here either — that
      // yanked the user's utterance off the top. The reply grows below the
      // pinned utterance (and is spoken), so the user keeps their read-back.
      voiceCurrentMsgBody.textContent = voiceCurrentMsgText;
      // Browser tier — server isn't sending TTS PCM frames; speak deltas
      // locally via window.speechSynthesis. Buffer until a sentence
      // terminator so we don't speak fragmented words.
      if (voiceBrowserTtsActive && msg.text) {
        _voiceBrowserTtsBuf += msg.text;
        const SENT = /[.!?]["')\]]?(\s|$)/g;
        let lastCut = 0;
        let m;
        while ((m = SENT.exec(_voiceBrowserTtsBuf)) !== null) {
          const sentence = _voiceBrowserTtsBuf.slice(lastCut, m.index + m[0].length).trim();
          if (sentence && 'speechSynthesis' in window) {
            const u = new SpeechSynthesisUtterance(sentence);
            try {
              const r = parseFloat(localStorage.getItem('lax_speed') || '1.0');
              if (r > 0.4 && r < 2.5) u.rate = r;
            } catch {}
            const v = _browserResolveVoice();
            if (v) u.voice = v;
            window.speechSynthesis.speak(u);
          }
          lastCut = m.index + m[0].length;
        }
        if (lastCut > 0) _voiceBrowserTtsBuf = _voiceBrowserTtsBuf.slice(lastCut);
      }
      break;
    case 'assistant_done':
    case 'assistant_interrupted':
      if (voiceCurrentMsgText.trim() && typeof activeChat !== 'undefined' && activeChat) {
        activeChat.messages.push({ role: 'assistant', content: voiceCurrentMsgText });
        activeChat.updatedAt = Date.now();
        if (typeof saveChats === 'function') saveChats();
        if (typeof renderSidebar === 'function') renderSidebar();
      }
      // Speak any leftover buffer (last sentence without terminator)
      if (voiceBrowserTtsActive) {
        const tail = _voiceBrowserTtsBuf.trim();
        if (tail && 'speechSynthesis' in window) {
          const u = new SpeechSynthesisUtterance(tail);
          try {
            const r = parseFloat(localStorage.getItem('lax_speed') || '1.0');
            if (r > 0.4 && r < 2.5) u.rate = r;
          } catch {}
          const v = _browserResolveVoice();
          if (v) u.voice = v;
          window.speechSynthesis.speak(u);
        }
        _voiceBrowserTtsBuf = "";
      }
      voiceCurrentMsgEl = null; voiceCurrentMsgBody = null; voiceCurrentMsgText = '';
      break;
    case 'tts_interrupt':
      if (voicePlaybackNode) voicePlaybackNode.port.postMessage({ cmd: 'flush' });
      break;
    case 'playback_complete':
    case 'tts_idle':
      isSpeaking = false; updateVoiceUI();
      // Sphere transitions to idle via the audio-frame watchdog (800ms of
      // no PCM frames) — these events fire when the SIDECAR queue is empty
      // but the worklet's ring buffer can still have audio. Trusting them
      // here cut the visible pulse short before the user's speakers stopped.
      break;
    case 'visual':
      // LLM-driven particle directive. The agent called voice_visual mid-
      // reply; sphere morphs to the requested form for ~durationMs.
      if (window.VoiceSphere && typeof VoiceSphere.handleDirective === 'function') {
        VoiceSphere.handleDirective({
          kind: msg.kind, value: msg.value, durationMs: msg.durationMs,
        });
      }
      break;
    case 'tts_fallback':
      // Clone engine was down/errored; the sidecar substituted a backup
      // voice. Reply still plays — tell the user why it sounds different
      // instead of silently switching voices.
      console.warn('[voice] tts fallback', msg.from, '→', msg.to, msg.reason);
      showVoiceIssueBanner(
        'Clone voice unavailable — replies are using a backup voice (' + (msg.to || 'built-in') + '). ' +
        'Settings → Media → Repair usually fixes this.');
      break;
    case 'stt_fallback':
      // GPU transcription crashed; the sidecar switched speech-to-text to
      // CPU. Mic still works (slower) — say so, with the repair path.
      console.warn('[voice] stt fallback →', msg.to, msg.reason);
      showVoiceIssueBanner(
        'Voice input switched to CPU after a GPU error — the mic works but responds slower. ' +
        'Settings → Media → Repair the Lite sidecar to fix permanently.');
      break;
    case 'voice_error':
    case 'agent_error':
    case 'stt_error':
    case 'tts_error':
      // These used to be console-only, which made real failures (crashing
      // GPU transcription) look like a dead mic. Anything the voice pipeline
      // reports as an error is user-visible now.
      console.warn('[voice]', msg.type, msg.message);
      showVoiceIssueBanner(
        'Voice pipeline error: ' + String(msg.message || msg.type).slice(0, 140) + ' — ' +
        'if this keeps happening, use Settings → Media → Repair.');
      break;
  }
}

// ── Voice issue banner ──
// Persistent (dismissable) banner for voice-pipeline problems. A toast
// disappears in 2s; a user whose mic "isn't working" needs the message to
// still be there when they look up. Deduped: repeating errors update the
// one banner instead of stacking. Rate-limited to one re-show per 30s after
// dismiss so a crash-looping pipeline doesn't nag every utterance.
let _voiceBannerDismissedAt = 0;
function showVoiceIssueBanner(text) {
  if (Date.now() - _voiceBannerDismissedAt < 30000) return;
  let el = document.getElementById('voice-issue-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'voice-issue-banner';
    el.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9997;max-width:640px;width:92%;padding:10px 38px 10px 14px;border:1px solid #dba917;background:rgba(50,38,4,.95);color:#ffd977;border-radius:10px;font-size:.82rem;line-height:1.4;backdrop-filter:blur(6px);box-shadow:0 2px 14px rgba(219,169,23,.25)';
    const x = document.createElement('button');
    x.textContent = '×';
    x.setAttribute('aria-label', 'Dismiss');
    x.style.cssText = 'position:absolute;top:4px;right:8px;background:none;border:none;color:#ffd977;font-size:1.1rem;cursor:pointer;padding:2px 6px';
    x.onclick = () => { _voiceBannerDismissedAt = Date.now(); el.remove(); };
    el.appendChild(x);
    const span = document.createElement('span');
    span.id = 'voice-issue-banner-text';
    el.appendChild(span);
    document.body.appendChild(el);
  }
  const span = document.getElementById('voice-issue-banner-text');
  if (span) span.textContent = text;
}
