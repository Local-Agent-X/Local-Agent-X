// ── Chat: Voice mode (full mic streaming pipeline) ──
//
// Server-side voice pipeline (Python GPU sidecar / Sherpa fallback) with
// browser-side mic capture + audio playback worklets. Handles start /
// stop / cleanup of the voice WS connection, audio worklets, and
// VoiceSphere visualization.
//
// State (voiceMode, voiceWS, voiceCtx, voiceMicNode, voicePlaybackNode,
// voiceMicStream, voiceCurrentMsg*, _voiceSilenceTimer, voiceSR,
// voiceSRRestartGuard, voiceBrowserTtsActive, _voiceBrowserTtsBuf) lives
// in chat-voice.js. handleVoiceWsMessage lives in chat-voice-ws-handler.js.

async function startVoiceMode() {
  if (voiceMode) return;
  try {
    // 1) Connect to /ws/voice with auth token.
    //
    // Use a LOCAL ws reference for everything in this init function. The
    // global voiceWS used to be assigned and then read back in handler
    // attach + send calls — but a stale onclose from a previous session
    // could fire mid-init and null voiceWS via cleanupVoiceResources,
    // causing a TypeError on `voiceWS.onmessage = ...`. The local ref
    // immunizes us from that race; the wrap-onclose closure-guards the
    // cleanup so only the CURRENT WS triggers a global teardown.
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice?token=${encodeURIComponent(AUTH_TOKEN)}`;
    const ws = new WebSocket(wsUrl);
    voiceWS = ws;
    ws.binaryType = 'arraybuffer';

    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('voice ws error'));
      ws.onclose = (e) => {
        if (ws.readyState !== WebSocket.OPEN) reject(new Error(`voice ws closed before open (code ${e.code})`));
      };
    });

    // Attach handlers BEFORE hello so server-side ready/init events aren't lost.
    // The onclose closure compares ws to the current voiceWS — if a fresh
    // session has reassigned voiceWS, this stale handler is a no-op.
    ws.onmessage = handleVoiceWsMessage;
    ws.onclose = () => {
      if (voiceWS !== ws) return; // stale handler from a prior session
      console.log('[voice] ws closed');
      cleanupVoiceResources();
    };

    // 2) Send hello + saved voice/speed settings. Mode tells the server
    // whether to run the full agent pipeline (chat) or stop after Whisper
    // and emit the transcript only (dictate). Server-side guards in
    // voice-session.ts and gpu-session.ts skip agent_start + TTS in
    // dictate mode so the user only gets the transcript, not a phantom
    // agent reply.
    const sid = (typeof activeChat !== 'undefined' && activeChat?.id) ? activeChat.id : 'default';
    const sessionMode = dictateMode ? 'dictate' : 'chat';
    ws.send(JSON.stringify({ type: 'hello', sessionId: 'chat-' + sid + '-' + Date.now(), mode: sessionMode }));
    const savedVoice = localStorage.getItem('lax_voice') || 'am_michael';
    const savedSpeed = parseFloat(localStorage.getItem('lax_speed') || '1.15');
    ws.send(JSON.stringify({ type: 'voice_settings', voice: savedVoice, speed: savedSpeed }));

    // 3) AudioContext + worklets. Cache-bust the worklet URLs — without the
    // version param, an older browser-cached worklet file (missing the
    // registerProcessor call) silently "loads" but doesn't register the
    // processor name, then `new AudioWorkletNode(ctx, 'mic-capture')` throws
    // "mic-capture is not defined in AudioWorkletGlobalScope". Bump the
    // version when the worklet code changes.
    //
    // Browser tier branch: if the user picked the "Browser" voice tier the
    // server has no STT — we run Web Speech API client-side and ship final
    // transcripts via the WS `transcript` message. We still need a mic stream
    // for the sphere's analyser, but skip the mic-capture worklet (no PCM
    // streaming) and skip the playback worklet (browser tier uses
    // window.speechSynthesis for TTS, never receives PCM frames).
    const activeTier = (typeof window.getActiveVoiceTier === 'function') ? window.getActiveVoiceTier() : null;
    const isBrowserTier = activeTier?.id === 'browser';
    voiceBrowserTtsActive = isBrowserTier;
    _voiceBrowserTtsBuf = "";

    voiceCtx = new AudioContext();
    if (!isBrowserTier) {
      await voiceCtx.audioWorklet.addModule('/js/voice/mic-capture-worklet.js?v=vb2');
      await voiceCtx.audioWorklet.addModule('/js/voice/playback-worklet.js?v=vb2');
    }

    // 4) Mic capture
    voiceMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const source = voiceCtx.createMediaStreamSource(voiceMicStream);
    if (!isBrowserTier) {
      voiceMicNode = new AudioWorkletNode(voiceCtx, 'mic-capture');
      voiceMicNode.port.onmessage = (e) => {
        if (!e.data || e.data.type !== 'pcm') return;
        // Push-to-talk gate: when the configured mode is 'push-to-talk' or
        // 'toggle' and the gate is closed, drop frames instead of forwarding.
        // Mode 'off' returns gate=open (or null) so behavior is unchanged.
        if (window.PushToTalk && window.PushToTalk.getState() === 'closed') return;
        if (voiceWS && voiceWS.readyState === WebSocket.OPEN) voiceWS.send(e.data.pcm);
      };
      source.connect(voiceMicNode);
      voiceMicNode.port.postMessage({ cmd: 'start' });
    } else {
      // Browser tier — start SpeechRecognition. Same engine the dictate
      // button uses, but here finals go to the server over the WS as
      // transcript messages so the agent loop runs.
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        alert('This browser does not support SpeechRecognition. Switch to a Chromium-based browser, or pick a different voice tier (Edge cloud, Kokoro local).');
        throw new Error('SpeechRecognition unavailable');
      }
      voiceSR = new SR();
      voiceSR.continuous = true;
      voiceSR.interimResults = true;
      voiceSR.lang = navigator.language || 'en-US';
      voiceSR.maxAlternatives = 1;
      voiceSR.onresult = (event) => {
        if (window.PushToTalk && window.PushToTalk.getState() === 'closed') return;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = (result[0].transcript || '').trim();
          if (!transcript) continue;
          const isFinal = !!result.isFinal;
          if (voiceWS && voiceWS.readyState === WebSocket.OPEN) {
            voiceWS.send(JSON.stringify({ type: 'transcript', text: transcript, isFinal }));
          }
        }
      };
      voiceSR.onerror = (event) => {
        // 'no-speech' and 'aborted' are routine — ignore. Other errors
        // surface to console; we attempt to restart unless we already are.
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        console.warn('[voice-sr] error:', event.error);
      };
      voiceSR.onend = () => {
        // SR stops itself after periods of silence; auto-restart while voice
        // mode is on. Guard against tight loops if start() throws.
        if (!voiceMode || voiceSRRestartGuard) return;
        voiceSRRestartGuard = true;
        try { voiceSR && voiceSR.start(); } catch (e) {
          console.warn('[voice-sr] restart failed:', e && e.message);
        }
        setTimeout(() => { voiceSRRestartGuard = false; }, 250);
      };
      try { voiceSR.start(); } catch (e) {
        console.warn('[voice-sr] initial start failed:', e && e.message);
      }
    }

    // 5) Playback — only for tiers that receive PCM TTS frames over the WS.
    // Browser tier uses window.speechSynthesis (driven by assistant_delta
    // events), so no PCM playback worklet is needed.
    if (!isBrowserTier) {
      voicePlaybackNode = new AudioWorkletNode(voiceCtx, 'pcm-playback');
      voicePlaybackNode.connect(voiceCtx.destination);
    }

    // 6) Sphere visualization — tap mic + TTS playback through analysers
    if (window.VoiceSphere) {
      try {
        const micAna = voiceCtx.createAnalyser(); micAna.fftSize = 2048;
        source.connect(micAna);
        const savedMode = localStorage.getItem('lax_voice_view_mode') || 'split';
        VoiceSphere.show(savedMode);
        VoiceSphere.attachMicAnalyser(micAna);
        if (voicePlaybackNode) {
          const ttsAna = voiceCtx.createAnalyser(); ttsAna.fftSize = 2048;
          voicePlaybackNode.connect(ttsAna);
          VoiceSphere.attachTtsAnalyser(ttsAna);
        }
        VoiceSphere.setState('idle');
      } catch (sphereErr) { console.warn('[voice-sphere] init failed:', sphereErr); }
    }

    // 7) Push-to-talk: bind the configured hotkey now that the session is
    // live. The gate's open/closed state is checked inside the mic-frame
    // forwarder above; this also drives the sphere dim/brighten visual.
    if (window.PushToTalk) {
      try {
        window.PushToTalk.init({
          onStateChange: (s) => {
            if (window.VoiceSphere && window.VoiceSphere.setGateState) {
              window.VoiceSphere.setGateState(s);
            }
          },
        });
      } catch (pttErr) { console.warn('[push-to-talk] init failed:', pttErr); }
    }

    voiceMode = true;
    voiceEnabled = true;
    // Only flip the chat-mode UI labels in actual voice-chat mode. Dictate
    // reuses the same WS + sphere infra but is a different product surface
    // — labeling its session as "VOICE ON" + lighting up the mic-btn would
    // mislead the user into thinking the agent is listening for a reply.
    if (!dictateMode) {
      const ttsBtn = document.getElementById('tts-toggle');
      if (ttsBtn) { ttsBtn.textContent = 'VOICE ON'; ttsBtn.className = 'active'; }
    }
    updateVoiceUI();
    console.log(`[voice] session started (mode=${dictateMode ? 'dictate' : 'chat'})`);
  } catch (e) {
    console.error('[voice] start failed:', e);
    cleanupVoiceResources();
    alert('Voice mode failed. Check microphone permissions.\n' + e.message);
  }
}

function stopVoiceMode() {
  if (!voiceMode) return;
  try { voiceWS && voiceWS.send(JSON.stringify({ type: 'bye' })); } catch {}
  try { voiceWS && voiceWS.close(); } catch {}
  cleanupVoiceResources();
  console.log('[voice] session stopped');
}

function cleanupVoiceResources() {
  voiceMode = false; voiceEnabled = false; isListening = false; isSpeaking = false;
  if (window.PushToTalk && window.PushToTalk.destroy) {
    try { window.PushToTalk.destroy(); } catch {}
  }
  try { voiceMicStream && voiceMicStream.getTracks().forEach(t => t.stop()); } catch {}
  try { voiceCtx && voiceCtx.close(); } catch {}
  // Stop client-side STT (browser tier) + cancel any pending speech.
  if (voiceSR) {
    try { voiceSR.onend = null; voiceSR.onresult = null; voiceSR.onerror = null; voiceSR.stop(); } catch {}
    voiceSR = null;
  }
  if (voiceBrowserTtsActive && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
  voiceBrowserTtsActive = false;
  _voiceBrowserTtsBuf = "";
  voiceWS = null; voiceCtx = null; voiceMicNode = null; voicePlaybackNode = null; voiceMicStream = null;
  voiceCurrentMsgEl = null; voiceCurrentMsgBody = null; voiceCurrentMsgText = '';
  const ttsBtn = document.getElementById('tts-toggle');
  if (ttsBtn) { ttsBtn.textContent = 'VOICE OFF'; ttsBtn.className = ''; }
  if (window.VoiceSphere) { try { VoiceSphere.hide(); } catch {} }
  try { renderVoiceEngineBadge(null); } catch {}
  window.LAX_VOICE_RUNTIME = null;
  updateVoiceUI();
}

