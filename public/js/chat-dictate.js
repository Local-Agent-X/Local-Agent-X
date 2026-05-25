// ── Chat: Dictate mode ──
//
// Speech-to-text only path. Native browser SpeechRecognition; no LLM, no TTS.
// Drops Whisper-equivalent transcripts into the message textarea so the
// user can review and send manually. Mutually exclusive with full voice
// mode — toggleMic / toggleDictate stop each other.
//
// State (dictateMode, dictateSR, dictateMicStream, dictateCtx,
// dictateRestartGuard) lives in chat-voice.js so the kernel/voice-mic
// path can read it without circular deps. References resolve via the
// shared script-global lexical environment of classic <script> tags.
//
// External deps: VoiceSphere (voice-sphere.js), apiFetch / esc (shared.js).

// ── Dictate mode ──
// Speech-to-text only — pipes Whisper finals into the message textarea so
// the user can review and send manually. No agent reply, no TTS playback.
// Reuses the voice WS, mic-capture worklet, and sphere visualization, but
// short-circuits the agent_start / assistant_delta event flow on the client.
// A pending server-side `mode: "dictate"` flag would let us skip TTS init
// entirely (~80MB Kokoro download); for v1 the model loads but never fires
// because we don't auto-submit transcripts.

async function toggleDictate(targetId) {
  if (dictateMode) { stopDictate(); }
  else {
    if (voiceMode) stopVoiceMode();   // mutex: only one mic mode at a time
    dictateTargetId = (typeof targetId === 'string' && targetId) ? targetId : 'msg-input';
    await startDictate();
  }
}

// Electron-Chromium strips the Google Speech API key, so webkitSpeechRecognition
// fails with `network` error on every utterance. The desktop app routes
// around it in two ways, in preference order:
//   1. Native OS recognizer (SFSpeechRecognizer on macOS, System.Speech on
//      Windows) via window.desktop.nativeSpeech — zero install, no model
//      download. Same bridge voice mode uses.
//   2. Server-side Whisper via POST /api/voice/dictate-once — needs ffmpeg
//      on PATH + the Whisper model downloaded. Used as fallback when the
//      native helper isn't available (e.g. Linux).
const isElectronRuntime = () =>
  typeof navigator !== "undefined" &&
  /electron/i.test(navigator.userAgent || "");

// Mode flag the shared native-speech listener checks before forwarding
// transcripts to the textarea. Mutually exclusive with voiceNativeActive
// because dictateMode itself is mutually exclusive with voiceMode.
let dictateNativeActive = false;

async function startDictate() {
  if (dictateMode) return;
  if (isElectronRuntime()) {
    // Streaming over /ws/voice (mode=dictate) is the default — partial
    // transcripts arrive while the user speaks, matching real-browser
    // Web Speech UX. Falls back to the legacy record-then-POST path
    // (startDictateElectron) when the streaming WS can't open.
    // Native OS recognizer (SFSpeechRecognizer) is opt-in via the
    // lax_native_speech localStorage flag — it produces zero transcripts
    // on unsigned dev builds and is currently parked pending signing.
    const nativeOptIn = (() => { try { return localStorage.getItem('lax_native_speech') === 'true'; } catch { return false; } })();
    const nativeSpeech = window.desktop?.nativeSpeech;
    if (nativeOptIn && nativeSpeech && await nativeSpeech.available()) {
      return startDictateNative();
    }
    return startDictateStreaming();
  }
  // Browser SpeechRecognition is the right tool for one-shot dictation:
  // instant-on, native streaming partials, no model download, no WebSocket.
  // Quality is roughly base.en-equivalent (~3-5% WER). If unavailable
  // (Firefox/Safari without webkit prefix) we'd fall back to the WS
  // pipeline, but Chrome/Edge cover the vast majority of users.
  // Browser support summary (last verified: 2026-05):
  //   Chrome / Edge / Brave / Opera (desktop + Android) → works (Google cloud ASR)
  //   Safari (macOS 14.1+ / iOS 14.5+)                  → works (webkitSpeechRecognition prefix; Apple on-device ASR on newer hardware)
  //   Firefox                                          → flag-gated, disabled by default
  //
  // For Firefox / unsupported browsers we tell the user how to recover
  // (switch browser, or use Voice Mode which goes through the local
  // Whisper WS pipeline and works everywhere).
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert(
      "Dictation isn't supported in this browser.\n\n" +
      "Works in Chrome, Edge, Brave, Opera, and Safari (Mac 14.1+ / iOS 14.5+).\n" +
      "Doesn't work in Firefox (disabled by default).\n\n" +
      "Two fallbacks:\n" +
      "  1. Switch to a Chromium-based browser, or\n" +
      "  2. Use Voice Mode (the 🎤 button) which uses the local Whisper pipeline and works everywhere.",
    );
    return;
  }
  try {
    dictateMode = true;
    dictateRestartGuard = false;

    // Mic stream for sphere visualization. Browser SR opens its own mic
    // session internally (we don't get its audio) — this getUserMedia is
    // ONLY for the AnalyserNode that drives the dust particle reactions.
    // Cheap; same permission prompt as voice mode.
    try {
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
    } catch (sphereErr) {
      // Sphere is decoration — keep going if mic-for-visuals fails.
      console.warn('[dictate] sphere mic init failed (continuing without visualization):', sphereErr);
    }

    // SpeechRecognition itself
    dictateSR = new SR();
    dictateSR.continuous = true;       // mic stays hot until user stops
    dictateSR.interimResults = true;   // live streaming partials
    dictateSR.lang = navigator.language || 'en-US';
    dictateSR.maxAlternatives = 1;

    dictateSR.onresult = (event) => {
      const preview = document.getElementById('dictate-preview');
      let interim = '';
      // Walk new results since last event. Final results commit to the
      // textarea via appendDictatedText (handles capitalize + period join).
      // Interim results stack into the preview row below the textarea.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          appendDictatedText(transcript);
        } else {
          interim += transcript;
        }
      }
      if (preview) {
        preview.textContent = interim;
        preview.style.display = interim ? 'block' : 'none';
      }
    };

    dictateSR.onerror = (event) => {
      console.warn('[dictate] SR error:', event.error, event.message || '');
      // Non-fatal errors: 'no-speech', 'audio-capture' (transient mic glitch),
      // 'aborted' (we stopped it). Fatal: 'not-allowed' (mic permission denied).
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        alert('Mic permission denied. Allow microphone access for dictation.');
        stopDictate();
      }
    };

    dictateSR.onend = () => {
      // SR auto-stops after silence on some browsers even with continuous=true.
      // Restart it so the mic stays hot until the user explicitly stops.
      if (dictateMode && !dictateRestartGuard) {
        try { dictateSR.start(); } catch {} // already-started errors are fine
      }
    };

    dictateSR.start();
    updateDictateUI();
    // Focus the textarea so Enter routes through handleInputKeydown
    // (stops dictation) instead of triggering the dictate-btn click again.
    // Without this the user's Enter could hit whatever element had focus
    // when they clicked the button.
    document.getElementById(dictateTargetId)?.focus();
    console.log('[dictate] started (browser SpeechRecognition)');
  } catch (e) {
    console.error('[dictate] start failed:', e);
    dictateMode = false;
    cleanupDictateResources();
    alert('Could not start dictation: ' + (e?.message || e));
  }
}

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

function stopDictate() {
  if (!dictateMode) return;
  dictateMode = false;
  dictateRestartGuard = true; // block onend from auto-restarting

  // Native OS recognizer path: stop the helper and free the sphere mic.
  // No buffer flush to wait on — transcripts arrive event-by-event so
  // anything already typed is already in the textarea.
  if (dictateNativeActive) {
    dictateNativeActive = false;
    try { window.desktop?.nativeSpeech?.stop(); } catch {}
    cleanupDictateResources();
    const preview = document.getElementById('dictate-preview');
    if (preview) { preview.textContent = ''; preview.style.display = 'none'; }
    updateDictateUI();
    const ta = document.getElementById(dictateTargetId);
    if (ta) {
      ta.focus();
      const len = ta.value.length;
      try { ta.setSelectionRange(len, len); } catch {}
    }
    console.log('[dictate] stopped (native)');
    return;
  }

  // Streaming WS path: send bye so the server commits a final transcript,
  // then close. cleanupDictateResources handles mic + worklet + WS
  // teardown. Don't wait for the `final` event — it arrives async via
  // handleVoiceWsMessage and routes through appendDictatedText.
  if (voiceWS && voiceWS.readyState === WebSocket.OPEN) {
    try { voiceWS.send(JSON.stringify({ type: 'bye' })); } catch {}
    try { voiceWS.close(); } catch {}
    cleanupDictateResources();
    updateDictateUI();
    const ta = document.getElementById(dictateTargetId);
    if (ta) {
      ta.focus();
      const len = ta.value.length;
      try { ta.setSelectionRange(len, len); } catch {}
    }
    console.log('[dictate] stopped (streaming WS)');
    return;
  }

  // Electron / MediaRecorder path: kick off the flush and let onstop own
  // the rest (cleanup, POST, focus). Bailing here keeps mic teardown out
  // of the race window between stop() and the final dataavailable event.
  if (dictateRecorder) {
    try {
      if (dictateRecorder.state !== 'inactive') dictateRecorder.stop();
      else { cleanupDictateResources(); updateDictateUI(); }
    } catch {
      cleanupDictateResources();
      updateDictateUI();
    }
    // Intentionally NOT nulling dictateRecorder — onstop reads it and
    // cleanupDictateResources nulls it after the flush completes.
    console.log('[dictate] stopped (Electron — awaiting transcribe)');
    return;
  }

  // Browser-SR path: SR.stop() is synchronous, tear down immediately.
  cleanupDictateResources();
  const preview = document.getElementById('dictate-preview');
  if (preview) { preview.textContent = ''; preview.style.display = 'none'; }
  updateDictateUI();
  // Cursor back to the textarea + caret at end so the next Enter sends
  // the dictated message instead of falling through to nothing.
  const ta = document.getElementById(dictateTargetId);
  if (ta) {
    ta.focus();
    const len = ta.value.length;
    try { ta.setSelectionRange(len, len); } catch {}
  }
  console.log('[dictate] stopped');
}

function cleanupDictateResources() {
  try { dictateSR && dictateSR.stop(); } catch {}
  dictateSR = null;
  // dictateRecorder is normally already stopped by stopDictate (so its
  // onstop has fired). Guard the redundant stop() in case cleanup is
  // called from a failed startDictateElectron before the recorder ran.
  try {
    if (dictateRecorder && dictateRecorder.state !== 'inactive') dictateRecorder.stop();
  } catch {}
  dictateRecorder = null;
  // Streaming WS path stashes its AudioWorkletNode on the MediaStream so
  // we can disconnect it before the context closes (avoids a noisy
  // "AudioWorkletNode running after context close" warning).
  try {
    const micNode = dictateMicStream && dictateMicStream._micNode;
    if (micNode) { micNode.port.postMessage({ cmd: 'stop' }); micNode.disconnect(); }
  } catch {}
  try { dictateMicStream && dictateMicStream.getTracks().forEach(t => t.stop()); } catch {}
  dictateMicStream = null;
  try { dictateCtx && dictateCtx.close(); } catch {}
  dictateCtx = null;
  // Streaming dictate uses voiceWS — null it so a stale handler from the
  // closed socket doesn't drive UI state on a future session.
  if (voiceWS) {
    try { voiceWS.close(); } catch {}
    voiceWS = null;
  }
  if (window.VoiceSphere) { try { VoiceSphere.hide(); } catch {} }
}

function updateDictateUI() {
  // Toggle whichever button kicked off this dictation. Both main chat and
  // the IDE composer have their own dictate button; only one is active at
  // a time (dictateMode + dictateTargetId enforce mutex). Always reset the
  // off-target button so a previous dictating-state class doesn't linger.
  const targetBtnId = dictateTargetId === 'ide-chat-input' ? 'ide-dictate-btn' : 'dictate-btn';
  const ALL_BTNS = ['dictate-btn', 'ide-dictate-btn'];
  for (const id of ALL_BTNS) {
    const b = document.getElementById(id);
    if (!b) continue;
    if (id === targetBtnId && dictateMode) {
      b.classList.add('dictating');
      b.title = 'Stop dictation (or press Enter)';
    } else {
      b.classList.remove('dictating');
      b.title = 'Dictate (speech to text only — no agent reply)';
    }
  }
}

// Append a Whisper-finalized utterance into the message textarea with
// dumb multi-sentence joining: space + capitalize next + add terminal
// punctuation if missing. Whisper does intra-utterance punctuation well;
// cross-utterance is best-effort. User edits before sending = safety net.
function appendDictatedText(utterance) {
  const ta = document.getElementById(dictateTargetId);
  if (!ta || !utterance) return;
  let text = utterance.trim();
  if (!text) return;
  const existing = ta.value;
  if (existing.length === 0) {
    // First utterance — capitalize first character if it isn't already.
    text = text.charAt(0).toUpperCase() + text.slice(1);
    ta.value = text;
  } else {
    // Continuation — ensure prior text terminates, then capitalize new.
    const lastChar = existing.charAt(existing.length - 1);
    const needsTerminator = !/[.!?,;:]/.test(lastChar);
    const sep = needsTerminator ? '. ' : ' ';
    const cap = text.charAt(0).toUpperCase() + text.slice(1);
    ta.value = existing + sep + cap;
  }
  // Auto-grow + scroll to end so the user sees what just landed.
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.scrollTop = ta.scrollHeight;
  // Clear preview row — that partial is now committed above.
  const preview = document.getElementById('dictate-preview');
  if (preview) preview.textContent = '';
}

// Centralized textarea Enter handler. Dictate mode steals Enter for stop;
// otherwise normal send. Shift-Enter always inserts a newline (textarea default).
function handleInputKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (dictateMode) { stopDictate(); }
  else { sendMessage(); }
}

