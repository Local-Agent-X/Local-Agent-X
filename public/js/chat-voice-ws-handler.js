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
    case 'vad_speech_start': isListening = true; updateVoiceUI();
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
      // Voice mode: commit the user's utterance straight into the thread. No
      // live partial preview — the agent turn is already triggered server-side
      // off the same final, so a preview bubble only adds a perceived
      // transcribe-then-send step without saving any time.
      const empty = document.getElementById('empty');
      if (empty) empty.remove();
      if (typeof addMessageEl === 'function') addMessageEl('user', msg.text);
      if (typeof activeChat !== 'undefined' && activeChat) {
        activeChat.messages.push({ role: 'user', content: msg.text });
        activeChat.updatedAt = Date.now();
      }
      break;
    }
    case 'partial': {
      // Streaming Sherpa partial — only rendered in dictate mode (ghost preview
      // row below the textarea; `final` commits it to the textarea). Voice mode
      // shows nothing live — words land as the committed user message on final.
      if (!dictateMode || !msg.text) break;
      const preview = document.getElementById('dictate-preview');
      if (preview) {
        preview.textContent = msg.text;
        preview.style.display = 'block';
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
        if (voiceCurrentMsgBody) voiceCurrentMsgBody.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
      }
      voiceCurrentMsgText = '';
      isSpeaking = true; updateVoiceUI();
      // Sphere stays in 'thinking' here — it transitions to 'speaking' when
      // the first audio frame actually arrives at the playback worklet,
      // which is when the user hears anything (the SoVITS synth + sentence
      // buffering adds 1-3s of lag after text starts streaming).
      break;
    }
    case 'assistant_delta':
      if (!voiceCurrentMsgBody) break;
      voiceCurrentMsgText += msg.text || '';
      voiceCurrentMsgBody.innerHTML = (typeof md === 'function' ? md(voiceCurrentMsgText) : voiceCurrentMsgText);
      const msgs = document.getElementById('messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
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
    case 'voice_error':
    case 'agent_error':
    case 'stt_error':
    case 'tts_error':
      console.warn('[voice]', msg.type, msg.message);
      break;
  }
}
