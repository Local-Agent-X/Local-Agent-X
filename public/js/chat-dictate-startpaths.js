// -- Chat: Dictate mode -- alternate start paths --
//
// Non-browser-SpeechRecognition dictation start implementations, split out
// of chat-dictate.js. Classic browser script (no import/export); these
// declarations are script-globals shared across <script> tags. Must load
// BEFORE chat-dictate.js. At load time this file defines globals but does
// not read any symbol owned by chat-dictate.js -- the back-references
// (appendDictatedText, stopDictate, cleanupDictateResources, updateDictateUI,
// dictateMode, dictateNativeActive, dictateTargetId, voiceWS, etc.) all fire
// at runtime from inside these functions.
//
// External deps: VoiceSphere (voice-sphere.js), handleVoiceWsMessage
// (chat-voice-ws-handler.js), AUTH_TOKEN / activeChat (shared.js).

// Native OS recognizer path. Same bridge voice mode uses — see
// desktop/src/native-speech.ts and the LaxSpeech.app / lax-speech-win.exe
// helpers. No mic capture in the renderer (the helper owns the mic);
// we just feed VoiceSphere a separate AudioContext stream for visuals
// and let the helper stream transcripts back via IPC.
let _dictateNativeListenerAttached = false;

async function startDictateNative() {
  try {
    dictateMode = true;
    dictateNativeActive = true;
    dictateRestartGuard = false;

    // Pre-prompt for mic access at the OS level so the helper's
    // AVAudioEngine doesn't get silently denied (or, worse, get back
    // zero-amplitude buffers that look like silence). Renderer does NOT
    // call getUserMedia on this path — observed behavior was the helper
    // getting one initial buffer then silence whenever the renderer
    // held a parallel audio capture session. Sphere stays in idle
    // visualization until we add a transcript-driven pulse here.
    if (window.desktop?.requestMediaAccess) {
      const granted = await window.desktop.requestMediaAccess('microphone');
      if (!granted) {
        dictateMode = false;
        dictateNativeActive = false;
        alert('Microphone access denied. Enable it in System Settings → Privacy & Security → Microphone for Local Agent X.');
        return;
      }
    }
    if (window.VoiceSphere) {
      try {
        const savedMode = localStorage.getItem('lax_voice_view_mode') || 'split';
        VoiceSphere.show(savedMode);
        VoiceSphere.setState('listening');
      } catch (sphereErr) {
        console.warn('[dictate-native] sphere show failed (continuing):', sphereErr);
      }
    }

    // Attach the IPC listener once per page lifetime. Multiple .on() calls
    // would multicast every transcript — we only want one handler.
    if (!_dictateNativeListenerAttached) {
      _dictateNativeListenerAttached = true;
      window.desktop.nativeSpeech.onEvent((ev) => {
        if (!ev || typeof ev !== 'object') return;
        // Both dictate and voice listeners are attached at module level;
        // each gates on its own active flag so they don't cross-fire.
        if (!dictateNativeActive) return;
        if (ev.type === 'result') {
          const text = (ev.text || '').trim();
          if (!text) return;
          if (ev.isFinal) {
            appendDictatedText(text);
            const preview = document.getElementById('dictate-preview');
            if (preview) { preview.textContent = ''; preview.style.display = 'none'; }
          } else {
            const preview = document.getElementById('dictate-preview');
            if (preview) { preview.textContent = text; preview.style.display = 'block'; }
          }
        } else if (ev.type === 'auth') {
          alert(
            'macOS denied Speech Recognition for Local Agent X.\n\n' +
            'Open System Settings → Privacy & Security → Speech Recognition and enable Local Agent X, then click dictate again.',
          );
          stopDictate();
        } else if (ev.type === 'error') {
          console.warn('[dictate-native] helper error:', ev.code, ev.message);
        }
      });
    }

    await window.desktop.nativeSpeech.start();
    updateDictateUI();
    document.getElementById(dictateTargetId)?.focus();
    console.log('[dictate] started (native OS recognizer)');
  } catch (e) {
    console.error('[dictate-native] start failed:', e);
    dictateMode = false;
    dictateNativeActive = false;
    cleanupDictateResources();
    alert('Could not start dictation: ' + (e?.message || e));
  }
}

// Streaming dictation via /ws/voice (mode=dictate). Mirrors the WS+worklet
// pipeline voice mode uses, but the server-side voice-session skips agent
// reply / TTS when mode=dictate, so the client just receives `partial` and
// `final` transcript events (already wired in chat-voice-ws-handler.js to
// fill the preview row + appendDictatedText respectively). Partials arrive
// as the user speaks — matches real-browser Web Speech UX.
async function startDictateStreaming() {
  try {
    dictateMode = true;
    dictateRestartGuard = false;

    // Electron mic TCC prompt — getUserMedia alone won't surface the OS
    // dialog under hardened runtime. Handled here so the prompt fires
    // before AudioContext setup.
    if (window.desktop?.requestMediaAccess) {
      const granted = await window.desktop.requestMediaAccess('microphone');
      if (!granted) {
        dictateMode = false;
        alert('Microphone access denied. Enable it in System Settings → Privacy & Security → Microphone for Local Agent X.');
        return;
      }
    }

    // 1) WebSocket to /ws/voice. Closure-guard the onclose so a stale
    // close from a prior session can't tear down the current one.
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice?token=${encodeURIComponent(AUTH_TOKEN)}`;
    const ws = new WebSocket(wsUrl);
    voiceWS = ws;
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('dictate ws error'));
      ws.onclose = (e) => {
        if (ws.readyState !== WebSocket.OPEN) reject(new Error(`dictate ws closed before open (code ${e.code})`));
      };
    });
    ws.onmessage = handleVoiceWsMessage;
    ws.onclose = () => {
      if (voiceWS !== ws) return;
      console.log('[dictate] ws closed');
      stopDictate();
    };

    // 2) Hello with mode=dictate. voice-session.ts forces server STT for
    // this mode even when the user's voiceSettings.sttProvider is "browser"
    // — Electron-Chromium can't run Web Speech, so dictate always needs
    // server-side recognition.
    const sid = (typeof activeChat !== 'undefined' && activeChat?.id) ? activeChat.id : 'default';
    ws.send(JSON.stringify({ type: 'hello', sessionId: 'dictate-' + sid + '-' + Date.now(), mode: 'dictate' }));

    // 3) AudioContext + mic-capture worklet. Same worklet voice mode uses
    // — it emits {type:'pcm', pcm: Int16Array} every ~20ms, which we ship
    // to the server WS as binary frames.
    dictateCtx = new AudioContext();
    await dictateCtx.audioWorklet.addModule('/js/voice/mic-capture-worklet.js?v=vb2');

    dictateMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const source = dictateCtx.createMediaStreamSource(dictateMicStream);
    const micNode = new AudioWorkletNode(dictateCtx, 'mic-capture');
    micNode.port.onmessage = (e) => {
      if (!e.data || e.data.type !== 'pcm') return;
      if (voiceWS && voiceWS.readyState === WebSocket.OPEN) voiceWS.send(e.data.pcm);
    };
    source.connect(micNode);
    micNode.port.postMessage({ cmd: 'start' });
    // Stash on dictate state so stopDictate can disconnect it.
    dictateMicStream._micNode = micNode;

    // 4) Sphere reacts to mic level via a tap off the same source.
    if (window.VoiceSphere) {
      try {
        const ana = dictateCtx.createAnalyser();
        ana.fftSize = 2048;
        source.connect(ana);
        const savedMode = localStorage.getItem('lax_voice_view_mode') || 'split';
        VoiceSphere.show(savedMode);
        VoiceSphere.attachMicAnalyser(ana);
        VoiceSphere.setState('listening');
      } catch (sphereErr) {
        console.warn('[dictate-streaming] sphere init failed:', sphereErr);
      }
    }

    updateDictateUI();
    document.getElementById(dictateTargetId)?.focus();
    console.log('[dictate] started (streaming WS)');
  } catch (e) {
    console.error('[dictate-streaming] start failed:', e);
    dictateMode = false;
    cleanupDictateResources();
    alert('Could not start dictation: ' + (e?.message || e));
  }
}

// Electron / server-Whisper batch path. Legacy fallback only — preferred
// path is now startDictateStreaming (streaming partials over the WS).
// Kept because some scenarios (server WS unreachable, future Linux build)
// may still need a record-then-POST option.
async function startDictateElectron() {
  try {
    dictateMode = true;
    dictateRestartGuard = false;

    // macOS Electron quirk: getUserMedia doesn't surface the TCC prompt on
    // its own under hardened runtime. Ask via the main process first so the
    // OS dialog actually appears the first time the user clicks dictate.
    // No-op on non-macOS / non-Electron (preload bridge is absent there).
    if (window.desktop?.requestMediaAccess) {
      const granted = await window.desktop.requestMediaAccess('microphone');
      if (!granted) {
        dictateMode = false;
        alert('Microphone access denied. Enable it in System Settings → Privacy & Security → Microphone for Local Agent X.');
        return;
      }
    }

    dictateMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    dictateCtx = new AudioContext();
    const source = dictateCtx.createMediaStreamSource(dictateMicStream);
    if (window.VoiceSphere) {
      const ana = dictateCtx.createAnalyser();
      ana.fftSize = 2048;
      source.connect(ana);
      const savedMode = localStorage.getItem('lax_voice_view_mode') || 'split';
      VoiceSphere.show(savedMode);
      VoiceSphere.attachMicAnalyser(ana);
      VoiceSphere.setState('listening');
    }

    // MediaRecorder defaults to audio/webm;codecs=opus on Chromium —
    // the server's ffmpeg pipeline auto-detects the container.
    // Mime captured up-front so onstop doesn't need to read the
    // (potentially nulled-out) global recorder ref.
    const chunks = [];
    const rec = new MediaRecorder(dictateMicStream);
    const recMime = rec.mimeType || 'audio/webm';
    dictateRecorder = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    // onstop fires AFTER stopDictate returns. It owns the rest of the
    // teardown for this code path: build the blob from the chunks the
    // closure captured, free the mic + AudioContext + sphere, then POST.
    // Tearing those down inside stopDictate (as we did initially) raced
    // the MediaRecorder flush — the mic stream tracks died before the
    // final dataavailable event fired, producing a zero-byte blob.
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: recMime });
      chunks.length = 0;
      cleanupDictateResources();
      updateDictateUI();
      const ta = document.getElementById(dictateTargetId);
      if (ta) {
        ta.focus();
        const len = ta.value.length;
        try { ta.setSelectionRange(len, len); } catch {}
      }
      if (blob.size === 0) {
        const preview = document.getElementById('dictate-preview');
        if (preview) { preview.textContent = ''; preview.style.display = 'none'; }
        return;
      }
      transcribeAndAppend(blob);
    };
    rec.start();

    updateDictateUI();
    document.getElementById(dictateTargetId)?.focus();
    console.log('[dictate] started (Electron / server Whisper)');
  } catch (e) {
    console.error('[dictate] electron start failed:', e);
    dictateMode = false;
    cleanupDictateResources();
    alert('Could not start dictation: ' + (e?.message || e));
  }
}

async function transcribeAndAppend(blob) {
  const preview = document.getElementById('dictate-preview');
  if (preview) {
    preview.textContent = 'Transcribing…';
    preview.style.display = 'block';
  }
  try {
    const r = await fetch(
      `/api/voice/dictate-once?token=${encodeURIComponent(AUTH_TOKEN)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'audio/webm',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: blob,
      },
    );
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${errBody.slice(0, 200)}`);
    }
    const { text } = await r.json();
    if (text) {
      appendDictatedText(text);
    } else if (preview) {
      preview.textContent = 'No speech detected';
      setTimeout(() => { preview.textContent = ''; preview.style.display = 'none'; }, 1500);
      return;
    }
    if (preview) { preview.textContent = ''; preview.style.display = 'none'; }
  } catch (e) {
    console.error('[dictate] server transcribe failed:', e);
    if (preview) {
      preview.textContent = 'Transcription failed — try again';
      preview.style.display = 'block';
      setTimeout(() => { preview.textContent = ''; preview.style.display = 'none'; }, 3000);
    }
  }
}
