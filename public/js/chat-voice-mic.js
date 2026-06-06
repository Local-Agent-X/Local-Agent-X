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

// Track whether the current voice session is running the Electron-only
// native-speech bridge (SFSpeechRecognizer on macOS, System.Speech on
// Windows) instead of webkitSpeechRecognition. Browser-tier voice in the
// desktop app routes through here because Electron-Chromium ships without
// Google's Speech API key. Wired below in startVoiceMode().
let voiceNativeActive = false;
let voiceNativeListenerAttached = false;

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
    // Determine which side runs STT this session. Browser tier in a real
    // browser uses webkitSpeechRecognition (Google's cloud ASR via the
    // browser's baked-in key). Electron-Chromium ships without that key,
    // so its renderer reports clientStt=false even on the Browser tier;
    // the server then runs Whisper + Sherpa streaming partials for it.
    // Same flag drives whether we set up webkitSR (client) or the
    // mic-capture-worklet (server-STT).
    const activeTier = (typeof window.getActiveVoiceTier === 'function') ? window.getActiveVoiceTier() : null;
    const isBrowserTier = activeTier?.id === 'browser';
    const isElectronRuntime = /electron/i.test(navigator.userAgent || '');
    const useClientStt = isBrowserTier && !isElectronRuntime;
    // TTS stays on speechSynthesis for browser tier in both environments —
    // OS voices, no install.
    voiceBrowserTtsActive = isBrowserTier;
    _voiceBrowserTtsBuf = "";

    const sid = (typeof activeChat !== 'undefined' && activeChat?.id) ? activeChat.id : 'default';
    const sessionMode = dictateMode ? 'dictate' : 'chat';
    ws.send(JSON.stringify({
      type: 'hello',
      sessionId: 'chat-' + sid + '-' + Date.now(),
      mode: sessionMode,
      clientStt: useClientStt,
    }));
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
    // mic-capture worklet streams PCM whenever the server is doing STT
    // (everything except the real-browser-with-Web-Speech case). Playback
    // worklet receives TTS PCM only when the server is also doing TTS —
    // browser tier uses speechSynthesis instead.
    voiceCtx = new AudioContext();
    if (useClientStt) {
      // Real browser + browser tier: nothing to register; webkit handles
      // capture + recognition, speechSynthesis handles playback.
    } else {
      await voiceCtx.audioWorklet.addModule('/js/voice/mic-capture-worklet.js?v=vb2');
      if (!voiceBrowserTtsActive) {
        await voiceCtx.audioWorklet.addModule('/js/voice/playback-worklet.js?v=vb2');
      }
    }

    // 4) Mic capture
    // macOS Electron quirk: getUserMedia doesn't surface the TCC prompt on
    // its own under hardened runtime. Ask via the main process first so the
    // OS dialog actually appears the first time voice mode runs. No-op on
    // non-macOS / non-Electron (preload bridge is absent there).
    if (window.desktop?.requestMediaAccess) {
      const granted = await window.desktop.requestMediaAccess('microphone');
      if (!granted) {
        throw new Error('Microphone access denied — enable it in System Settings → Privacy & Security → Microphone for Local Agent X.');
      }
    }
    voiceMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const source = voiceCtx.createMediaStreamSource(voiceMicStream);
    if (!useClientStt) {
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
      // Browser tier — STT runs client-side. In a real browser we use
      // webkitSpeechRecognition (Google cloud ASR via the browser's
      // baked-in API key). In Electron-Chromium that key is stripped, so
      // the desktop app instead routes to the native OS recognizer
      // (SFSpeechRecognizer on macOS via LaxSpeech.app, System.Speech on
      // Windows via lax-speech-win.exe). Transcript shape is identical —
      // both paths send {type:'transcript', text, isFinal} over the WS,
      // so the server-side voice-session logic doesn't know or care
      // which client-side recognizer produced the text.
      const nativeSpeech = window.desktop?.nativeSpeech;
      const useNativeSpeech = !!nativeSpeech && await nativeSpeech.available();
      if (useNativeSpeech) {
        voiceNativeActive = true;
        if (!voiceNativeListenerAttached) {
          voiceNativeListenerAttached = true;
          nativeSpeech.onEvent((ev) => {
            if (!ev || typeof ev !== 'object') return;
            if (ev.type === 'result') {
              // Mirror chat-voice-mic's existing PTT gate so push-to-talk
              // still works with native recognition.
              if (window.PushToTalk && window.PushToTalk.getState() === 'closed') return;
              const text = (ev.text || '').trim();
              if (!text) return;
              console.log(`[voice-native] ${ev.isFinal ? 'FINAL' : 'interim'}: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
              if (voiceWS && voiceWS.readyState === WebSocket.OPEN) {
                voiceWS.send(JSON.stringify({ type: 'transcript', text, isFinal: !!ev.isFinal }));
              }
            } else if (ev.type === 'auth') {
              // macOS Speech Recognition denied / not determined. Surface
              // a clear recovery path — there's no JS way to re-prompt
              // once denied; user has to flip the toggle in Settings.
              alert(
                'macOS denied Speech Recognition for Local Agent X.\n\n' +
                'Open System Settings → Privacy & Security → Speech Recognition and enable Local Agent X, then click the mic again.',
              );
              stopVoiceMode();
            } else if (ev.type === 'error') {
              console.warn('[voice-native] helper error:', ev.code, ev.message);
            }
          });
        }
        await nativeSpeech.start();
        // Native path skips the entire SpeechRecognition setup below;
        // the rest of the session (WS, sphere, push-to-talk) is shared.
      } else {
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
      // Lifecycle diagnostics — narrow down where voice gets stuck. Each event
      // tells us a different stage:
      //   onstart       SR connected to its audio source (Google cloud STT)
      //   onaudiostart  user agent began capturing audio
      //   onsoundstart  audio above noise threshold detected
      //   onspeechstart speech (intelligible) detected
      //   onresult      transcript chunk delivered (final or interim)
      // Missing onstart → SR can't reach its STT backend (offline, blocked).
      // onstart fires but onaudiostart doesn't → SR can't get the mic.
      // onaudiostart fires but onsoundstart doesn't → mic is silent.
      // onsoundstart fires but onspeechstart doesn't → noise but not speech.
      // onspeechstart fires but onresult doesn't → STT backend silent.
      voiceSR.onstart = () => console.log('[voice-sr] onstart — SR backend connected, listening');
      voiceSR.onaudiostart = () => console.log('[voice-sr] onaudiostart — capturing audio');
      voiceSR.onsoundstart = () => console.log('[voice-sr] onsoundstart — audio detected');
      voiceSR.onspeechstart = () => console.log('[voice-sr] onspeechstart — speech detected');
      voiceSR.onspeechend = () => console.log('[voice-sr] onspeechend');
      voiceSR.onresult = (event) => {
        if (window.PushToTalk && window.PushToTalk.getState() === 'closed') return;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = (result[0].transcript || '').trim();
          if (!transcript) continue;
          const isFinal = !!result.isFinal;
          console.log(`[voice-sr] onresult ${isFinal ? 'FINAL' : 'interim'}: "${transcript.slice(0, 60)}${transcript.length > 60 ? '…' : ''}"`);
          if (voiceWS && voiceWS.readyState === WebSocket.OPEN) {
            voiceWS.send(JSON.stringify({ type: 'transcript', text: transcript, isFinal }));
          } else {
            console.warn('[voice-sr] WS not open — transcript dropped');
          }
        }
      };
      // Track consecutive audio-capture errors so we can back off when the
      // mic enters a sticky bad state instead of tight-looping.
      let _voiceSrAudioCaptureCount = 0;
      voiceSR.onerror = (event) => {
        // Classification matches chat-dictate.js so voice has the same
        // resilience dictation has had:
        //   - no-speech / aborted: routine, no log
        //   - audio-capture: transient mic glitch — let onend auto-restart
        //   - not-allowed / service-not-allowed: fatal, needs user action
        //   - other: surface for diagnosis
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        if (event.error === 'audio-capture') {
          _voiceSrAudioCaptureCount += 1;
          console.warn(`[voice-sr] audio-capture (transient #${_voiceSrAudioCaptureCount}) — onend will auto-restart`);
          return;
        }
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          console.error('[voice-sr] mic permission denied for SpeechRecognition — voice can\'t hear you. Grant mic permission and try again.');
          return;
        }
        console.warn('[voice-sr] error:', event.error);
      };
      voiceSR.onend = () => {
        // SR stops itself after periods of silence OR after transient errors.
        // Auto-restart while voice mode is on. Back off when audio-capture
        // is firing repeatedly (sticky mic state) so we don't tight-loop a
        // failing mic acquisition.
        if (!voiceMode || voiceSRRestartGuard) return;
        voiceSRRestartGuard = true;
        const delay = _voiceSrAudioCaptureCount > 0
          ? Math.min(2000, 250 * Math.pow(2, _voiceSrAudioCaptureCount - 1))  // 250 → 500 → 1000 → 2000ms
          : 250;
        setTimeout(() => {
          voiceSRRestartGuard = false;
          if (!voiceMode || !voiceSR) return;
          try {
            voiceSR.start();
            // Successful start clears the audio-capture streak. If start
            // threw or the mic is still bad, onerror fires again and we
            // back off further on the next round.
            if (_voiceSrAudioCaptureCount > 0) {
              console.log(`[voice-sr] restart succeeded after ${_voiceSrAudioCaptureCount} audio-capture error(s)`);
              _voiceSrAudioCaptureCount = 0;
            }
          } catch (e) {
            console.warn('[voice-sr] restart failed:', e && e.message);
          }
        }, delay);
      };
      try { voiceSR.start(); } catch (e) {
        console.warn('[voice-sr] initial start failed:', e && e.message);
      }
      } // end of useNativeSpeech else branch
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
        // Stay 'idle' so the inner particles keep their loose cloud form
        // (the prominent "dust"). voice-sphere.js's idle breath was patched
        // to also react to smoothedAmp, so the mic-driven pulse works in
        // idle now too — no need to morph to the tight dyson shell.
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
  // Electron native-speech bridge — same role as voiceSR but the recognizer
  // runs in the LaxSpeech.app helper process, not in the renderer.
  if (voiceNativeActive) {
    voiceNativeActive = false;
    try { window.desktop?.nativeSpeech?.stop(); } catch {}
  }
  if (voiceBrowserTtsActive && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
  voiceBrowserTtsActive = false;
  _voiceBrowserTtsBuf = "";
  voiceWS = null; voiceCtx = null; voiceMicNode = null; voicePlaybackNode = null; voiceMicStream = null;
  voiceCurrentMsgEl = null; voiceCurrentMsgBody = null; voiceCurrentMsgText = '';
  voicePartialEl = null; voicePartialBody = null;
  const ttsBtn = document.getElementById('tts-toggle');
  if (ttsBtn) { ttsBtn.textContent = 'VOICE OFF'; ttsBtn.className = ''; }
  if (window.VoiceSphere) { try { VoiceSphere.hide(); } catch {} }
  try { renderVoiceEngineBadge(null); } catch {}
  window.LAX_VOICE_RUNTIME = null;
  updateVoiceUI();
}

