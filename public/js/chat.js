// ── Chat Panel ──
let streaming = false;
let pendingUploads = [];
let userScrolledUp = false;

// Detect when user scrolls away from bottom — pause auto-scroll
(function initScrollPause() {
  const el = document.getElementById('messages');
  if (!el) { document.addEventListener('DOMContentLoaded', initScrollPause); return; }
  el.addEventListener('wheel', () => {
    if (!streaming) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    userScrolledUp = !atBottom;
  });
  el.addEventListener('scroll', () => {
    if (!streaming) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) userScrolledUp = false;
  });
})();

function autoScroll() {
  if (userScrolledUp) return;
  const el = document.getElementById('messages');
  if (el) el.scrollTop = el.scrollHeight;
}

// Voice state
let voiceEnabled = false, isListening = false, isSpeaking = false;
let mediaRecorder = null, audioChunks = [], audioContext = null;
let ttsQueue = [], ttsSentenceBuffer = '', currentAudioSource = null;

function renderMessages() {
  const el = document.getElementById('messages');
  if (!el) return;
  if (!activeChat || activeChat.messages.length === 0) {
    el.innerHTML = `<div id="empty"><h2>SECRET AGENT X</h2><p>${activeChat ? 'Start your conversation below.' : 'Select a chat or start a new one.'}</p></div>`;
    return;
  }
  el.innerHTML = '';
  for (const msg of activeChat.messages) {
    if (msg.role === 'user') {
      const displayText = msg.attachments ? msg.content.replace(/^Attached files:\n[\s\S]*?\n\n/, '') : msg.content;
      addMessageEl('user', displayText, msg.attachments);
    } else if (msg.role === 'assistant' && msg.content) {
      addMessageEl('assistant', msg.content);
    }
  }
  el.scrollTop = el.scrollHeight;
}

async function sendMessage() {
  if (streaming) return;
  userScrolledUp = false; // Reset scroll lock when user sends
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && pendingUploads.length === 0) return;
  // Capture attachments before clearing
  const msgAttachments = pendingUploads.length ? pendingUploads.map(f => ({
    name: f.name, size: f.size, type: f.type, isImage: f.isImage,
    url: f.url || f.dataUrl || null
  })) : null;
  const hasImages = msgAttachments && msgAttachments.some(a => a.isImage);
  const nonImageFiles = msgAttachments ? msgAttachments.filter(a => !a.isImage) : [];
  const uploadPrefix = nonImageFiles.length
    ? `Attached files:\n${nonImageFiles.map(f => `- ${f.name} (${f.size} bytes)`).join('\n')}\n\n`
    : (hasImages && !text ? '' : '');
  const finalText = uploadPrefix + text;
  const displayText = text || '';
  input.value = ''; input.style.height = 'auto';
  pendingUploads = []; renderUploadPreviews();
  if (!activeChat) newChat();
  if (activeChat.messages.length === 0) {
    const titleSrc = text || (msgAttachments ? msgAttachments[0].name : 'New Chat');
    activeChat.title = titleSrc.slice(0, 50) + (titleSrc.length > 50 ? '...' : '');
    saveChats(); renderSidebar();
  }
  const empty = document.getElementById('empty'); if (empty) empty.remove();
  addMessageEl('user', displayText, msgAttachments);
  activeChat.messages.push({ role: 'user', content: finalText, attachments: msgAttachments });
  const msgEl = addMessageEl('assistant', '');
  const bodyEl = msgEl.querySelector('.msg-body');
  bodyEl.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
  streaming = true; stopSpeaking(); ttsSentenceBuffer = '';
  document.getElementById('send-btn').disabled = true;

  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ message: finalText, sessionId: activeChat.id, attachments: msgAttachments || [] }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', content = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          switch (event.type) {
            case 'stream':
              content += event.delta; bodyEl.innerHTML = md(content); feedTTS(event.delta); break;
            case 'tool_start':
              bodyEl.innerHTML = content ? md(content) : ''; bodyEl.appendChild(makeToolCard(event.toolName, event.args)); break;
            case 'tool_end': {
              const cards = bodyEl.querySelectorAll('.tool-card');
              const last = cards[cards.length - 1];
              if (last) { last.querySelector('.indicator').className = 'indicator ' + (event.allowed ? 'allowed' : 'blocked'); last.querySelector('.tool-detail').textContent = event.result.slice(0, 2000); }
              break;
            }
            case 'secret_request': showSecretModal(event.name, event.service, event.reason); break;
            case 'error': content += '\n\nError: ' + event.message; bodyEl.innerHTML = md(content); break;
          }
        } catch {}
      }
      autoScroll();
    }
    userScrolledUp = false; // Reset when stream ends
    if (content.trim()) { activeChat.messages.push({ role: 'assistant', content }); activeChat.updatedAt = Date.now(); saveChats(); renderSidebar(); }
  } catch (e) { bodyEl.textContent = 'Connection error: ' + e.message; }
  flushTTS(); streaming = false;
  document.getElementById('send-btn').disabled = false;
}

function addMessageEl(role, text, attachments) {
  const el = document.getElementById('messages');
  const div = document.createElement('div'); div.className = 'msg ' + role;
  let attachHtml = '';
  if (attachments && attachments.length) {
    attachHtml = '<div class="msg-attachments">' + attachments.map(a => {
      if (a.isImage && a.url) {
        return `<img src="${a.url}" alt="${esc(a.name)}" onclick="openLightbox(this.src)" title="${esc(a.name)}" />`;
      } else if (a.isImage) {
        return `<div class="att-badge"><span>&#128444;</span> ${esc(a.name)}</div>`;
      } else {
        return `<div class="att-badge"><span>&#128196;</span> ${esc(a.name)} (${(a.size / 1024).toFixed(1)}KB)</div>`;
      }
    }).join('') + '</div>';
  }
  const bodyContent = role === 'assistant' ? md(text) : esc(text);
  div.innerHTML = `<div class="msg-label">${role === 'user' ? 'You' : 'Assistant'}</div><div class="msg-body">${attachHtml}${bodyContent}</div>`;
  el.appendChild(div);
  // Scroll after images load (they change height)
  const imgs = div.querySelectorAll('.msg-attachments img');
  if (imgs.length) {
    imgs.forEach(img => img.onload = () => autoScroll());
  }
  autoScroll();
  return div;
}

function openLightbox(src) {
  let lb = document.getElementById('img-preview-overlay');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'img-preview-overlay';
    lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:10000;cursor:zoom-out;backdrop-filter:blur(4px)';
    lb.onclick = () => lb.style.display = 'none';
    document.body.appendChild(lb);
  }
  lb.innerHTML = `<img src="${src}" style="max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 0 40px rgba(0,0,0,.5)"/>`;
  lb.style.display = 'flex';
}

function toolSummary(name, args) {
  switch (name) {
    case 'browser': {
      const a = args.action || '';
      if (a === 'navigate') return `Opening ${args.url || 'page'}...`;
      if (a === 'snapshot') return 'Scanning page elements...';
      if (a === 'click') return args.ref ? `Clicking [${args.ref}]...` : `Clicking ${args.selector || 'element'}...`;
      if (a === 'click_text') return `Clicking "${args.text || ''}"...`;
      if (a === 'fill') return args.ref ? `Typing into [${args.ref}]...` : `Typing into ${args.selector || 'field'}...`;
      if (a === 'screenshot') return 'Taking screenshot...';
      if (a === 'extract') return 'Reading page content...';
      return `Browser: ${a}`;
    }
    case 'read': return `Reading ${(args.path || '').split(/[/\\]/).pop() || 'file'}`;
    case 'write': return `Writing ${(args.path || '').split(/[/\\]/).pop() || 'file'}`;
    case 'edit': return `Editing ${(args.path || '').split(/[/\\]/).pop() || 'file'}`;
    case 'bash': return `Running: ${(args.command || '').slice(0, 50)}`;
    case 'http_request': return `${args.method || 'GET'} ${(args.url || '').slice(0, 50)}`;
    case 'memory_search': return `Searching memory: "${(args.query || '').slice(0, 40)}"`;
    case 'memory_save': return `Saving to ${args.target || 'daily'} memory`;
    case 'generate_image': return `Generating: ${(args.prompt || '').slice(0, 40)}...`;
    default: return `${name} ${JSON.stringify(args).slice(0, 60)}`;
  }
}

function makeToolCard(name, args) {
  const card = document.createElement('div'); card.className = 'tool-card';
  card.innerHTML = `<div class="tool-header" onclick="this.parentElement.classList.toggle('open')"><span class="indicator"></span><span class="tool-name">${esc(name)}</span><span style="color:var(--muted);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(toolSummary(name, args))}</span><span style="color:var(--muted);font-size:.65rem">&#9654;</span></div><div class="tool-detail">executing...</div>`;
  return card;
}

// ── Secret modal ──
let pendingSecretName = '';
function showSecretModal(name, service, reason) {
  pendingSecretName = name;
  let overlay = document.getElementById('secret-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div'); overlay.id = 'secret-modal-overlay';
    overlay.innerHTML = `<div id="secret-modal"><h3 style="font-family:var(--mono);color:var(--accent);font-size:.95rem;margin-bottom:6px">Secret Requested</h3><div id="sm-service" style="color:var(--muted);font-size:.72rem;font-family:var(--mono);margin-bottom:12px"></div><div id="sm-name" style="display:inline-block;background:#1a1a30;border:1px solid var(--border);border-radius:6px;padding:3px 10px;font-family:var(--mono);font-size:.78rem;color:var(--accent);margin-bottom:12px"></div><div id="sm-reason" style="color:var(--muted);font-size:.82rem;margin-bottom:16px;line-height:1.5"></div><input type="password" id="secret-input" class="field-input" placeholder="Paste your secret here..." autocomplete="off" onkeydown="if(event.key==='Enter')submitSecret()"/><div style="font-size:.7rem;color:var(--muted);margin-top:8px">Encrypted and stored locally. Never appears in chat.</div><div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end"><button class="action-btn secondary" onclick="cancelSecret()">Cancel</button><button class="action-btn primary" onclick="submitSecret()">Save Secret</button></div></div>`;
    overlay.onclick = e => { if (e.target === overlay) cancelSecret(); };
    document.body.appendChild(overlay);
  }
  document.getElementById('sm-name').textContent = name;
  document.getElementById('sm-service').textContent = service ? `Service: ${service}` : '';
  document.getElementById('sm-reason').textContent = reason;
  document.getElementById('secret-input').value = '';
  overlay.classList.add('visible');
  setTimeout(() => document.getElementById('secret-input').focus(), 100);
}
async function submitSecret() {
  const v = document.getElementById('secret-input').value.trim(); if (!v) return;
  await apiPost('/api/secrets', { name: pendingSecretName, value: v });
  cancelSecret();
}
function cancelSecret() {
  const o = document.getElementById('secret-modal-overlay'); if (o) o.classList.remove('visible');
  pendingSecretName = '';
}

// ── Upload ──
function triggerUpload() { document.getElementById('file-input')?.click(); }
function handleFileUpload(event) {
  addFilesToUpload(Array.from(event.target.files || []));
}

function renderUploadPreviews() {
  const bar = document.getElementById('upload-previews');
  if (!bar) return;
  if (pendingUploads.length === 0) { bar.classList.remove('has-items'); bar.innerHTML = ''; return; }
  bar.classList.add('has-items');
  bar.innerHTML = pendingUploads.map((f, i) => {
    if (f.dataUrl) {
      return `<div style="position:relative;width:140px;height:110px;border-radius:10px;overflow:hidden;background:#111;border:1px solid var(--border);cursor:pointer;flex-shrink:0" onclick="previewImage('${i}')">
        <img src="${f.dataUrl}" style="width:100%;height:100%;object-fit:cover"/>
        <button onclick="event.stopPropagation();removeUpload(${i})" style="position:absolute;top:5px;right:5px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.65);border:none;color:#fff;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)">&times;</button>
      </div>`;
    }
    return `<div style="position:relative;display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;flex-shrink:0;min-width:180px">
      <div style="width:36px;height:36px;border-radius:8px;background:#1a1a30;display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0">&#128196;</div>
      <div style="min-width:0"><div style="font-size:.78rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">${esc(f.name)}</div><div style="font-size:.65rem;color:var(--muted)">${f.type || 'File'}</div></div>
      <button onclick="removeUpload(${i})" style="position:absolute;top:5px;right:5px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.65);border:none;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center">&times;</button>
    </div>`;
  }).join('');
}

// ── Voice v2: Always-On with simple VAD (no external libs) ──
// Uses Web Audio API volume detection — no ONNX, no worklets, just works.
let voiceMode = false;
let vadStream = null;
let vadAnalyser = null;
let vadContext = null;
let vadRecorder = null;
let vadChunks = [];
let silenceStart = 0;
let speechDetected = false;
const SPEECH_THRESHOLD = 15;   // Volume level to detect speech (0-255)
const SILENCE_DURATION = 1200; // ms of silence before ending recording
const MIN_SPEECH_MS = 500;     // Minimum speech duration to process

async function toggleMic() {
  if (voiceMode) { stopVoiceMode(); } else { await startVoiceMode(); }
}

async function startVoiceMode() {
  stopSpeaking();
  try {
    vadStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
    });

    vadContext = new AudioContext({ sampleRate: 16000 });
    const source = vadContext.createMediaStreamSource(vadStream);
    vadAnalyser = vadContext.createAnalyser();
    vadAnalyser.fftSize = 512;
    vadAnalyser.smoothingTimeConstant = 0.3;
    source.connect(vadAnalyser);

    voiceMode = true;
    voiceEnabled = true;
    const ttsBtn = document.getElementById('tts-toggle');
    if (ttsBtn) { ttsBtn.textContent = 'VOICE ON'; ttsBtn.className = 'active'; }
    updateVoiceUI();
    console.log('[voice] Always-on voice mode started');

    // Start monitoring loop
    monitorVoice();
  } catch (e) {
    console.error('[voice] Mic failed:', e);
    alert('Voice mode failed. Check microphone permissions.\nError: ' + e.message);
  }
}

function stopVoiceMode() {
  voiceMode = false; isListening = false; speechDetected = false;
  if (vadRecorder && vadRecorder.state !== 'inactive') vadRecorder.stop();
  if (vadStream) { vadStream.getTracks().forEach(t => t.stop()); vadStream = null; }
  if (vadContext) { vadContext.close(); vadContext = null; }
  vadAnalyser = null; vadRecorder = null; vadChunks = [];
  stopSpeaking(); updateVoiceUI();
  console.log('[voice] Voice mode stopped');
}

function monitorVoice() {
  if (!voiceMode || !vadAnalyser) return;

  const data = new Uint8Array(vadAnalyser.frequencyBinCount);
  vadAnalyser.getByteFrequencyData(data);
  const volume = data.reduce((a, b) => a + b, 0) / data.length;

  if (volume > SPEECH_THRESHOLD) {
    // Speech detected
    if (!speechDetected && !isSpeaking) {
      speechDetected = true;
      isListening = true;
      stopSpeaking(); // Interrupt TTS
      startRecording();
      updateVoiceUI();
    }
    silenceStart = 0;
  } else if (speechDetected) {
    // Silence after speech
    if (!silenceStart) silenceStart = Date.now();
    if (Date.now() - silenceStart > SILENCE_DURATION) {
      // Enough silence — stop recording and transcribe
      speechDetected = false;
      isListening = false;
      stopRecording();
      updateVoiceUI();
    }
  }

  requestAnimationFrame(monitorVoice);
}

function startRecording() {
  if (!vadStream || vadRecorder) return;
  vadChunks = [];
  vadRecorder = new MediaRecorder(vadStream, {
    mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
  });
  vadRecorder.ondataavailable = e => { if (e.data.size > 0) vadChunks.push(e.data); };
  vadRecorder.onstop = async () => {
    vadRecorder = null;
    if (vadChunks.length === 0) return;
    const blob = new Blob(vadChunks, { type: 'audio/webm' });
    vadChunks = [];

    // Skip very short recordings (noise, not speech)
    if (blob.size < 5000) return;

    updateVoiceUI('transcribing');
    try {
      const wavBlob = await webmToWav16k(blob);
      const r = await fetch(`${API}/api/voice/transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        body: new Uint8Array(await wavBlob.arrayBuffer()),
      });
      const d = await r.json();
      if (d.text?.trim() && d.text.trim().length > 1) {
        document.getElementById('msg-input').value = d.text.trim();
        sendMessage();
      }
    } catch (e) { console.error('[voice] STT failed:', e); }
    updateVoiceUI();
  };
  vadRecorder.start(100);
  console.log('[voice] Recording started');
}

function stopRecording() {
  if (vadRecorder && vadRecorder.state !== 'inactive') {
    vadRecorder.stop();
    console.log('[voice] Recording stopped');
  }
}

// Convert WebM → WAV 16kHz mono for Whisper
async function webmToWav16k(blob) {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  // Resample to 16kHz mono
  const offline = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);

  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  const ds = pcm.length * 2, hdr = new ArrayBuffer(44), v = new DataView(hdr);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0,'RIFF'); v.setUint32(4, 36+ds, true); w(8,'WAVE'); w(12,'fmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,16000,true); v.setUint32(28,32000,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
  w(36,'data'); v.setUint32(40,ds,true);
  return new Blob([hdr, pcm.buffer], { type: 'audio/wav' });
}
function toggleTTS() {
  voiceEnabled = !voiceEnabled;
  const btn = document.getElementById('tts-toggle');
  if (btn) { btn.textContent = voiceEnabled ? 'VOICE ON' : 'VOICE OFF'; btn.className = voiceEnabled ? 'active' : ''; }
  if (!voiceEnabled) stopSpeaking();
}
// Pre-fetch: start fetching next audio while current plays
let prefetchedAudio = null;

async function fetchTTSAudio(text) {
  const r = await fetch(`${API}/api/voice/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ text: text.trim(), speed: 1.15 })
  });
  if (!r.ok) return null;
  if (!audioContext) audioContext = new AudioContext();
  return await audioContext.decodeAudioData(await r.arrayBuffer());
}

async function speakSentence(text) {
  if (!voiceEnabled || !text.trim()) return;
  // Client-side cleanup — strip URLs, code, paths before sending
  let clean = text.replace(/https?:\/\/\S+/g, '').replace(/`[^`]+`/g, '')
    .replace(/[\w/\\.-]+\.(?:html|js|ts|css|json|md)\b/g, '').replace(/\([^)]{15,}\)/g, '').trim();
  if (clean.length < 4) { if (ttsQueue.length > 0) await speakSentence(ttsQueue.shift()); return; }

  isSpeaking = true; updateVoiceUI();
  try {
    // Use pre-fetched audio if available, otherwise fetch now
    let buf = prefetchedAudio; prefetchedAudio = null;
    if (!buf) buf = await fetchTTSAudio(clean);
    if (!buf) throw new Error('TTS empty');

    // Pre-fetch NEXT audio while this one plays (eliminates gap)
    if (ttsQueue.length > 0) {
      const nextText = ttsQueue[0].replace(/https?:\/\/\S+/g, '').replace(/`[^`]+`/g, '').trim();
      if (nextText.length > 3) fetchTTSAudio(nextText).then(a => { prefetchedAudio = a; });
    }

    const src = audioContext.createBufferSource(); src.buffer = buf; src.connect(audioContext.destination);
    currentAudioSource = src;
    await new Promise(res => { src.onended = res; src.start(); });
    currentAudioSource = null;
  } catch (e) { console.warn('[voice] TTS error:', e); }
  if (ttsQueue.length > 0) await speakSentence(ttsQueue.shift());
  else { isSpeaking = false; updateVoiceUI(); }
}
let ttsBatchBuffer = '';
function feedTTS(delta) {
  if (!voiceEnabled) return;
  ttsSentenceBuffer += delta;

  // Look for sentence boundaries
  const re = /[.!?]\s+|[.!?]$/;
  while (re.test(ttsSentenceBuffer)) {
    const m = ttsSentenceBuffer.match(re), idx = m.index + m[0].length;
    const s = ttsSentenceBuffer.slice(0, idx).trim();
    ttsSentenceBuffer = ttsSentenceBuffer.slice(idx);
    if (s.length > 3) ttsBatchBuffer += (ttsBatchBuffer ? ' ' : '') + s;
  }

  // Send batch when we have enough text (80+ chars = ~2 sentences)
  // This reduces pauses between sentences dramatically
  if (ttsBatchBuffer.length > 80) {
    const batch = ttsBatchBuffer; ttsBatchBuffer = '';
    isSpeaking ? ttsQueue.push(batch) : speakSentence(batch);
  }
}
function flushTTS() {
  // Flush any remaining batched text + sentence buffer
  const remaining = (ttsBatchBuffer + ' ' + ttsSentenceBuffer).trim();
  ttsBatchBuffer = '';
  if (voiceEnabled && remaining.length > 3) { isSpeaking ? ttsQueue.push(remaining) : speakSentence(remaining); }
  ttsSentenceBuffer = '';
}
function stopSpeaking() {
  try { currentAudioSource?.stop(); } catch {} currentAudioSource = null;
  ttsQueue = []; ttsSentenceBuffer = ''; isSpeaking = false; updateVoiceUI();
}
function updateVoiceUI(state) {
  const mic = document.getElementById('mic-btn'), ind = document.getElementById('voice-indicator');
  if (!mic) return;
  if (state === 'transcribing') { mic.className = 'input-btn listening'; if (ind) { ind.className = 'listening'; ind.textContent = '⚡ TRANSCRIBING...'; } return; }
  if (voiceMode) {
    mic.className = 'input-btn' + (isListening ? ' listening' : isSpeaking ? ' speaking' : ' listening');
    mic.title = 'Voice mode ON — click to stop';
    if (ind) {
      if (isListening) { ind.className = 'listening'; ind.textContent = '🎙 LISTENING...'; }
      else if (isSpeaking) { ind.className = 'speaking'; ind.textContent = '🔊 SPEAKING...'; }
      else { ind.className = 'listening'; ind.textContent = '🎙 VOICE MODE'; }
    }
  } else {
    mic.className = 'input-btn';
    mic.title = 'Click for voice mode (hands-free)';
    if (ind) { ind.className = ''; ind.textContent = ''; }
  }
}

// ── Keyboard shortcuts ──
document.addEventListener('keydown', e => {
  if (e.code === 'Escape') { if (voiceMode) stopVoiceMode(); else stopSpeaking(); }
});

// Auto-resize textarea
document.getElementById('msg-input')?.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 160) + 'px'; });

// ── Paste handling (images + files from clipboard) ──
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    addFilesToUpload(files);
  }
});

// ── Drag & drop ──
const dropTarget = document.getElementById('page-chat');
if (dropTarget) {
  dropTarget.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropTarget.style.outline = '2px dashed var(--accent)';
    dropTarget.style.outlineOffset = '-4px';
  });
  dropTarget.addEventListener('dragleave', () => {
    dropTarget.style.outline = '';
    dropTarget.style.outlineOffset = '';
  });
  dropTarget.addEventListener('drop', (e) => {
    e.preventDefault();
    dropTarget.style.outline = '';
    dropTarget.style.outlineOffset = '';
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0) addFilesToUpload(files);
  });
}

async function addFilesToUpload(files) {
  for (const f of files) {
    const isImage = f.type.startsWith('image/');
    const entry = { name: f.name, size: f.size, type: f.type, isImage, url: null, dataUrl: null };

    // Local preview for images
    if (isImage) {
      const reader = new FileReader();
      reader.onload = () => { entry.dataUrl = reader.result; renderUploadPreviews(); };
      reader.readAsDataURL(f);
    }

    pendingUploads.push(entry);
    renderUploadPreviews();

    // Upload to server in background
    const form = new FormData();
    form.append('file', f);
    try {
      const res = await apiFetch('/api/upload', { method: 'POST', body: form, headers: {} });
      const data = await res.json();
      if (data.files && data.files[0]) entry.url = data.files[0].url;
    } catch (e) { console.warn('Upload failed:', e); }
  }
}

function removeUpload(index) {
  pendingUploads.splice(index, 1);
  renderUploadPreviews();
}

function previewImage(index) {
  const f = pendingUploads[index];
  if (!f?.dataUrl) return;
  let overlay = document.getElementById('img-preview-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'img-preview-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:10000;cursor:pointer;backdrop-filter:blur(4px)';
    overlay.onclick = () => overlay.style.display = 'none';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<img src="${f.dataUrl}" style="max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 0 40px rgba(0,0,0,.5)"/>`;
  overlay.style.display = 'flex';
}

// Init chat on page load
function init_chat() { renderMessages(); }
