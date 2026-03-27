// ── Settings Panel ──

function init_settings() {
  loadSettings();
  loadSyncConfig();
  checkSettingsAuth();
  checkAnthropicAuth();
  checkServer('image');
  checkServer('video');
  checkVoiceCaps();
  loadToolsList();
  loadFileAccessMode();
  loadIntegrations();
  waCheckStatus();
}

function switchTab(id) {
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-pill').forEach(el => el.classList.remove('active'));
  const pane = document.getElementById('stab-' + id); if (pane) pane.classList.add('active');
  if (event?.target) event.target.classList.add('active');
}

function toggleSwitch(el) { el.classList.toggle('on'); }

async function checkSettingsAuth() {
  try {
    const d = await apiJson('/api/auth/status');
    const el = document.getElementById('auth-status');
    const loginBtn = document.getElementById('btn-login');
    const discBtn = document.getElementById('btn-disconnect');
    if (!el) return;
    if (d.authenticated) {
      el.className = 'status-badge ok'; el.innerHTML = '<span class="status-dot"></span> Connected — ' + (d.method === 'oauth' ? 'OpenAI OAuth' : 'API Key');
      if (loginBtn) { loginBtn.textContent = 'Already Connected'; loginBtn.disabled = true; }
      if (discBtn) discBtn.style.display = '';
    } else {
      el.className = 'status-badge err'; el.innerHTML = '<span class="status-dot"></span> Not connected';
      if (loginBtn) loginBtn.disabled = false;
      if (discBtn) discBtn.style.display = 'none';
    }
  } catch {}
}

async function doLogin() {
  try {
    const d = await apiPost('/api/auth/login', {});
    if (d.authUrl) window.open(d.authUrl, '_blank');
    setTimeout(checkSettingsAuth, 5000);
  } catch (e) { console.error('Login failed:', e); }
}

async function doDisconnect() {
  if (!confirm('Disconnect from OpenAI?')) return;
  await apiFetch('/api/auth/logout', { method: 'POST' });
  checkSettingsAuth(); checkAuth();
}

// ── Anthropic Auth ──

async function checkAnthropicAuth() {
  try {
    const d = await apiJson('/api/auth/anthropic/status');
    const el = document.getElementById('anthropic-auth-status');
    const loginBtn = document.getElementById('btn-anthropic-login');
    const discBtn = document.getElementById('btn-anthropic-disconnect');
    if (!el) return;
    if (d.authenticated && !d.expired) {
      el.className = 'status-badge ok';
      el.innerHTML = '<span class="status-dot"></span> Connected — Anthropic OAuth';
      if (loginBtn) { loginBtn.textContent = 'Already Connected'; loginBtn.disabled = true; }
      if (discBtn) discBtn.style.display = '';
    } else {
      el.className = 'status-badge err';
      el.innerHTML = '<span class="status-dot"></span> Not connected';
      if (loginBtn) { loginBtn.textContent = 'Sign In with Claude'; loginBtn.disabled = false; }
      if (discBtn) discBtn.style.display = 'none';
    }
  } catch {}
}

async function doAnthropicLogin() {
  try {
    const d = await apiPost('/api/auth/anthropic/login', {});
    if (d.authUrl) window.open(d.authUrl, '_blank');
    setTimeout(checkAnthropicAuth, 5000);
    setTimeout(checkAnthropicAuth, 15000);
  } catch (e) { console.error('Anthropic login failed:', e); }
}

async function doAnthropicDisconnect() {
  if (!confirm('Disconnect from Anthropic?')) return;
  await apiFetch('/api/auth/anthropic/logout', { method: 'POST' });
  checkAnthropicAuth();
}

async function checkServer(type) {
  const port = type === 'image' ? 7860 : 7861;
  const el = document.getElementById(type === 'image' ? 'img-status' : 'vid-status');
  if (!el) return;
  el.className = 'status-badge warn'; el.innerHTML = '<span class="status-dot"></span> Checking...';
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    el.className = 'status-badge ok'; el.innerHTML = `<span class="status-dot"></span> Running — ${d.device || 'ready'}`;
  } catch {
    el.className = 'status-badge err'; el.innerHTML = '<span class="status-dot"></span> Not running';
  }
}

async function startServer(type) {
  const script = type === 'image' ? 'workspace/sd-server/server.py' : 'workspace/sd-server/video-server.py';
  apiPost('/api/chat', { message: `start the ${type} server: python ${script}`, sessionId: 'settings-autostart' });
  setTimeout(() => checkServer(type), 5000);
}

async function checkVoiceCaps() {
  try {
    const d = await apiJson('/api/voice/capabilities');
    const stt = document.getElementById('stt-status'), tts = document.getElementById('tts-status');
    if (stt) { stt.className = d.stt !== 'none' ? 'status-badge ok' : 'status-badge err'; stt.innerHTML = `<span class="status-dot"></span> ${d.stt !== 'none' ? 'Whisper (' + d.whisperModel + ')' : 'Not available'}`; }
    if (tts) { tts.className = d.tts !== 'none' ? 'status-badge ok' : 'status-badge err'; tts.innerHTML = `<span class="status-dot"></span> ${d.tts !== 'none' ? d.tts + ' (' + d.ttsVoice + ')' : 'Not available'}`; }
  } catch {}
}

function loadToolsList() {
  const tools = [
    { name: 'read', status: 'allowed' }, { name: 'write', status: 'allowed' }, { name: 'edit', status: 'allowed' },
    { name: 'bash', status: 'rate-limited' }, { name: 'web_fetch', status: 'operator-only' },
    { name: 'http_request', status: 'operator-only' }, { name: 'browser', status: 'operator-only' },
    { name: 'generate_image', status: 'rate-limited' }, { name: 'generate_video', status: 'rate-limited' },
    { name: 'memory_search', status: 'allowed' }, { name: 'memory_save', status: 'allowed' },
    { name: 'memory_get', status: 'allowed' }, { name: 'request_secret', status: 'allowed' },
  ];
  const el = document.getElementById('tools-list'); if (!el) return;
  el.innerHTML = tools.map(t => {
    const color = t.status === 'allowed' ? 'var(--accent)' : t.status === 'rate-limited' ? 'var(--warn)' : 'var(--info)';
    return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text)">${t.name}</span><span style="color:${color}">${t.status}</span></div>`;
  }).join('');
}

// ── Provider change → toggle model input vs dropdown ──

async function onProviderChange(provider) {
  const modelInput = document.getElementById('cfg-model');
  const modelSelect = document.getElementById('cfg-model-select');
  const hint = document.getElementById('cfg-model-hint');
  const ollamaStatus = document.getElementById('ollama-status');
  if (!modelInput || !modelSelect) return;

  if (provider === 'local') {
    modelInput.style.display = 'none';
    modelSelect.style.display = '';
    if (ollamaStatus) ollamaStatus.style.display = '';
    if (hint) hint.textContent = 'Showing models downloaded via Ollama. Run "ollama pull <model>" to add more.';
    await loadLocalModels();
  } else {
    modelInput.style.display = '';
    modelSelect.style.display = 'none';
    if (ollamaStatus) ollamaStatus.style.display = 'none';
    if (hint) hint.textContent = 'Codex: gpt-5.3-codex | Anthropic: claude-sonnet-4-20250514 | xAI: grok-3-mini | OpenAI: gpt-4o';
  }
}

async function loadLocalModels() {
  const sel = document.getElementById('cfg-model-select');
  const statusEl = document.getElementById('ollama-status');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading...</option>';
  try {
    const data = await apiJson('/api/models/local');
    if (data.error) {
      sel.innerHTML = '<option value="">Ollama not reachable</option>';
      if (statusEl) statusEl.innerHTML = `<span class="status-badge err"><span class="status-dot"></span> Not running</span> <button class="btn" onclick="startOllama()" id="btn-start-ollama" style="padding:4px 12px;font-size:.72rem;color:var(--accent);margin-left:8px">Start Ollama</button>`;
      return;
    }
    const models = data.models || [];
    if (models.length === 0) {
      sel.innerHTML = '<option value="">No models found</option>';
      if (statusEl) statusEl.innerHTML = '<span class="status-badge warn"><span class="status-dot"></span> Running — no models</span> <span style="font-size:.7rem;color:var(--muted)">Run <code style="background:var(--bg2);padding:2px 6px;border-radius:4px">ollama pull llama3</code> to download a model</span>';
      return;
    }
    sel.innerHTML = models.map(m => {
      const sizeGB = m.size ? (m.size / 1024 / 1024 / 1024).toFixed(1) + ' GB' : '';
      return `<option value="${m.name}">${m.name}${sizeGB ? ' (' + sizeGB + ')' : ''}</option>`;
    }).join('');
    if (statusEl) statusEl.innerHTML = `<span class="status-badge ok"><span class="status-dot"></span> Running — ${models.length} model${models.length > 1 ? 's' : ''} available</span> <button class="btn" onclick="loadLocalModels()" style="padding:4px 10px;font-size:.7rem;margin-left:8px">Refresh</button>`;
    // Restore saved selection
    try {
      const s = JSON.parse(localStorage.getItem('sax_settings') || '{}');
      if (s.model) sel.value = s.model;
    } catch {}
  } catch {
    sel.innerHTML = '<option value="">Ollama not running</option>';
    if (statusEl) statusEl.innerHTML = `<span class="status-badge err"><span class="status-dot"></span> Not running</span> <button class="btn" onclick="startOllama()" id="btn-start-ollama" style="padding:4px 12px;font-size:.72rem;color:var(--accent);margin-left:8px">Start Ollama</button>`;
  }
}

async function startOllama() {
  const btn = document.getElementById('btn-start-ollama');
  if (btn) { btn.textContent = 'Starting...'; btn.disabled = true; }
  try {
    await apiPost('/api/ollama/start', {});
    // Poll until Ollama is reachable
    let attempts = 0;
    const check = setInterval(async () => {
      attempts++;
      try {
        const data = await apiJson('/api/models/local');
        if (!data.error) {
          clearInterval(check);
          await loadLocalModels();
        }
      } catch {}
      if (attempts > 15) { // 15s timeout
        clearInterval(check);
        if (btn) { btn.textContent = 'Start Ollama'; btn.disabled = false; }
      }
    }, 1000);
  } catch {
    if (btn) { btn.textContent = 'Start Ollama'; btn.disabled = false; }
  }
}

async function saveSettings() {
  const provider = document.getElementById('cfg-provider')?.value;
  const modelInput = document.getElementById('cfg-model');
  const modelSelect = document.getElementById('cfg-model-select');
  const model = provider === 'local' ? modelSelect?.value : modelInput?.value;
  const s = {
    provider,
    model,
    temperature: parseFloat(document.getElementById('cfg-temperature')?.value || '0.7'),
    imageEngine: document.getElementById('cfg-image-engine')?.value,
    sttEngine: document.getElementById('cfg-stt-engine')?.value,
    ttsEngine: document.getElementById('cfg-tts-engine')?.value,
    ttsVoice: document.getElementById('cfg-tts-voice')?.value,
    xttsVoice: document.getElementById('cfg-xtts-voice')?.value,
    sandbox: document.getElementById('cfg-sandbox')?.value,
  };
  localStorage.setItem('sax_settings', JSON.stringify(s));
  // Save provider + model to server (so backend knows which to use)
  await apiPost('/api/settings', { provider: s.provider, model: s.model, temperature: s.temperature });
  // Also save sync config to server
  await saveSyncConfig();
  const el = document.getElementById('save-status');
  if (el) { el.textContent = 'Saved'; setTimeout(() => el.textContent = '', 2000); }
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('sax_settings') || '{}');
    const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
    set('cfg-provider', s.provider); set('cfg-model', s.model); set('cfg-temperature', s.temperature);
    set('cfg-image-engine', s.imageEngine); set('cfg-stt-engine', s.sttEngine);
    set('cfg-tts-engine', s.ttsEngine); set('cfg-tts-voice', s.ttsVoice); set('cfg-sandbox', s.sandbox);
    set('cfg-xtts-voice', s.xttsVoice);
    // Show/hide XTTS sections based on engine
    if (s.ttsEngine) onTtsEngineChange(s.ttsEngine);
    // Show local model dropdown if provider is local
    if (s.provider) onProviderChange(s.provider);
  } catch {}
  checkSyncStatus();
}

// ── XTTS Voice Cloning ──

const XTTS_URL = 'http://127.0.0.1:7862';
let _voiceRecorder = null;
let _voiceChunks = [];

function onTtsEngineChange(engine) {
  const stdVoice = document.getElementById('tts-voice-field');
  const xttsVoice = document.getElementById('xtts-voice-field');
  const cloneSection = document.getElementById('voice-clone-section');
  if (!stdVoice) return;
  if (engine === 'xtts') {
    stdVoice.style.display = 'none';
    if (xttsVoice) xttsVoice.style.display = '';
    if (cloneSection) cloneSection.style.display = '';
    loadXttsVoices();
  } else {
    stdVoice.style.display = '';
    if (xttsVoice) xttsVoice.style.display = 'none';
    if (cloneSection) cloneSection.style.display = 'none';
  }
}

async function loadXttsVoices() {
  const sel = document.getElementById('cfg-xtts-voice');
  const list = document.getElementById('saved-voices-list');
  if (!sel) return;
  try {
    const r = await fetch(`${XTTS_URL}/voices`);
    const voices = await r.json();
    // Update dropdown
    sel.innerHTML = '<option value="">-- select voice --</option>';
    voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      sel.appendChild(opt);
    });
    // Restore selection
    try {
      const s = JSON.parse(localStorage.getItem('sax_settings') || '{}');
      if (s.xttsVoice) sel.value = s.xttsVoice;
    } catch {}
    // Update saved voices list
    if (list) {
      if (voices.length === 0) {
        list.innerHTML = '<p style="color:var(--muted);font-size:.75rem">No voices yet. Record or upload a sample above.</p>';
      } else {
        list.innerHTML = voices.map(v => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
            <div style="display:flex;align-items:center;gap:8px">
              <button class="btn" onclick="previewVoice('${v.id}')" title="Preview" style="padding:4px 8px;font-size:.75rem">&#9654;</button>
              <span style="font-family:var(--mono);font-size:.8rem">${esc(v.name)}</span>
              <span style="color:var(--muted);font-size:.7rem">${Math.round(v.size/1024)}KB</span>
            </div>
            <button class="btn" onclick="deleteVoice('${v.id}')" title="Delete" style="padding:4px 8px;font-size:.75rem;color:var(--danger)">&#10005;</button>
          </div>
        `).join('');
      }
    }
  } catch {
    sel.innerHTML = '<option value="">XTTS server not running</option>';
    if (list) list.innerHTML = '<div style="display:flex;align-items:center;gap:10px"><span style="color:var(--danger);font-size:.75rem">XTTS server not running</span><button class="btn" onclick="startXttsServer()" id="start-xtts-btn" style="padding:4px 12px;font-size:.72rem;color:var(--accent)">Start XTTS Server</button></div>';
  }
}

async function toggleVoiceRecording() {
  const btn = document.getElementById('record-voice-btn');
  const status = document.getElementById('record-status');
  if (_voiceRecorder && _voiceRecorder.state === 'recording') {
    _voiceRecorder.stop();
    btn.textContent = '\u{1F3A4} Record';
    btn.style.borderColor = '';
    if (status) status.textContent = 'Processing...';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _voiceChunks = [];
    _voiceRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    _voiceRecorder.ondataavailable = e => { if (e.data.size > 0) _voiceChunks.push(e.data); };
    _voiceRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(_voiceChunks, { type: 'audio/webm' });
      await sendVoiceSample(blob);
    };
    _voiceRecorder.start();
    btn.textContent = '\u{23F9} Stop Recording';
    btn.style.borderColor = 'var(--danger)';
    if (status) status.textContent = 'Recording... (6-10 seconds recommended)';
  } catch (e) {
    if (status) status.textContent = 'Mic access denied: ' + e.message;
  }
}

async function uploadVoiceSample(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const status = document.getElementById('record-status');
  if (status) status.textContent = 'Uploading ' + file.name + '...';
  await sendVoiceSample(file);
  input.value = '';
}

async function sendVoiceSample(blob) {
  const status = document.getElementById('record-status');
  const nameInput = document.getElementById('voice-clone-name');
  const name = nameInput?.value?.trim() || 'voice_' + Date.now();
  try {
    const formData = new FormData();
    formData.append('audio', blob, name + '.wav');
    formData.append('name', name);
    const r = await fetch(`${XTTS_URL}/clone`, { method: 'POST', body: formData });
    const d = await r.json();
    if (d.ok) {
      if (status) status.textContent = 'Voice "' + d.name + '" saved!';
      if (nameInput) nameInput.value = '';
      loadXttsVoices();
      // Auto-select new voice
      setTimeout(() => {
        const sel = document.getElementById('cfg-xtts-voice');
        if (sel) sel.value = d.id;
      }, 300);
    } else {
      if (status) status.textContent = 'Error: ' + (d.error || 'unknown');
    }
  } catch (e) {
    if (status) status.textContent = 'Upload failed: XTTS server not running?';
  }
}

async function startXttsServer() {
  const btn = document.getElementById('start-xtts-btn');
  if (btn) { btn.textContent = 'Starting...'; btn.disabled = true; }
  try {
    await apiPost('/api/voice/start-xtts', {});
    // Wait for model to be reachable (can take 30-60s first time)
    if (btn) btn.textContent = 'Loading model...';
    let attempts = 0;
    const check = setInterval(async () => {
      attempts++;
      try {
        const r = await fetch(XTTS_URL + '/health');
        if (r.ok) {
          clearInterval(check);
          loadXttsVoices();
          if (btn) { btn.textContent = 'Running'; btn.style.color = 'var(--accent)'; }
        }
      } catch {}
      if (attempts > 60) { // 2 min timeout
        clearInterval(check);
        if (btn) { btn.textContent = 'Start XTTS Server'; btn.disabled = false; }
      }
    }, 2000);
  } catch (e) {
    if (btn) { btn.textContent = 'Failed — retry'; btn.disabled = false; }
  }
}

async function previewVoice(voiceId) {
  try {
    const audio = new Audio(`${XTTS_URL}/voices/${voiceId}/preview`);
    audio.play();
  } catch {}
}

async function deleteVoice(voiceId) {
  if (!confirm('Delete voice "' + voiceId + '"?')) return;
  try {
    await fetch(`${XTTS_URL}/voices/${voiceId}`, { method: 'DELETE' });
    loadXttsVoices();
  } catch {}
}

// ── Agent Sync ──

async function checkSyncStatus() {
  try {
    const d = await apiJson('/api/sync/status');
    const el = document.getElementById('sync-status');
    if (!el) return;
    if (d.enabled) {
      el.className = 'status-badge ok';
      const ago = d.lastSync ? Math.round((Date.now() - d.lastSync) / 1000) : 0;
      el.innerHTML = `<span class="status-dot"></span> ${d.isSyncing ? 'Syncing...' : ago ? `Last synced ${ago}s ago` : 'Enabled — not yet synced'}`;
      const tog = document.getElementById('tog-sync'); if (tog) tog.classList.add('on');
    } else {
      el.className = 'status-badge warn';
      el.innerHTML = '<span class="status-dot"></span> Not configured';
    }
    // Populate form fields from server config
    if (d.repoUrl) {
      const repoEl = document.getElementById('cfg-sync-repo');
      if (repoEl && !repoEl.value) repoEl.value = d.repoUrl;
    }
  } catch {}
}

async function loadSyncConfig() {
  try {
    const d = await apiJson('/api/sync/status');
    const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
    set('cfg-sync-repo', d.repoUrl);
    set('cfg-sync-interval', d.interval);
    if (d.enabled) { const el = document.getElementById('tog-sync'); if (el) el.classList.add('on'); }
    if (d.autoDownload) { const el = document.getElementById('tog-sync-autodownload'); if (el) el.classList.add('on'); }
    if (d.syncSessions) { const el = document.getElementById('tog-sync-sessions'); if (el) el.classList.add('on'); }
    if (d.syncWorkspace) { const el = document.getElementById('tog-sync-workspace'); if (el) el.classList.add('on'); }
    if (d.syncCronJobs) { const el = document.getElementById('tog-sync-cron'); if (el) el.classList.add('on'); }
  } catch {}
}

async function saveSyncConfig() {
  const repo = document.getElementById('cfg-sync-repo')?.value?.trim();
  const token = document.getElementById('cfg-sync-token')?.value?.trim();
  const interval = document.getElementById('cfg-sync-interval')?.value;
  const enabled = document.getElementById('tog-sync')?.classList.contains('on');
  const autoDownload = document.getElementById('tog-sync-autodownload')?.classList.contains('on');
  const syncSessions = document.getElementById('tog-sync-sessions')?.classList.contains('on');
  const syncWorkspace = document.getElementById('tog-sync-workspace')?.classList.contains('on');
  const syncCronJobs = document.getElementById('tog-sync-cron')?.classList.contains('on');

  // Save token to secrets vault if provided
  if (token) {
    await apiPost('/api/secrets', { name: 'GITHUB_SYNC_TOKEN', value: token, service: 'GitHub Sync' });
    document.getElementById('cfg-sync-token').value = ''; // Clear from UI
  }

  await apiPost('/api/sync/configure', { enabled, repoUrl: repo, interval, autoDownload, syncSessions, syncWorkspace, syncCronJobs });
  checkSyncStatus();
}

function syncMsg(d) { return d.message || d.error || d.reason || JSON.stringify(d); }

async function syncNow() {
  const el = document.getElementById('sync-result');
  if (el) el.textContent = 'Syncing...';
  await saveSyncConfig();
  try {
    const d = await apiPost('/api/sync/push', {});
    if (el) el.textContent = d.success ? `Done: ${syncMsg(d)}` : `Error: ${syncMsg(d)}`;
  } catch (e) { if (el) el.textContent = 'Sync failed: ' + e.message; }
  setTimeout(checkSyncStatus, 1000);
}

async function forcePull() {
  const el = document.getElementById('sync-result');
  if (el) el.textContent = 'Pulling...';
  await saveSyncConfig();
  try {
    const d = await apiPost('/api/sync/pull', {});
    if (el) el.textContent = d.success ? `Done: ${syncMsg(d)}` : `Error: ${syncMsg(d)}`;
  } catch (e) { if (el) el.textContent = 'Pull failed: ' + e.message; }
}

async function forcePush() {
  const el = document.getElementById('sync-result');
  if (el) el.textContent = 'Pushing...';
  await saveSyncConfig();
  try {
    const d = await apiPost('/api/sync/push', {});
    if (el) el.textContent = d.success ? `Done: ${syncMsg(d)}` : `Error: ${syncMsg(d)}`;
  } catch (e) { if (el) el.textContent = 'Push failed: ' + e.message; }
}

// ── File Access Mode ──

const FILE_ACCESS_HINTS = {
  workspace: 'Strict: agent can only read project files and memory. Most secure.',
  common: 'Default: agent can also read Downloads, Documents, Desktop, Pictures.',
  unrestricted: 'Full access: agent can read any file on your computer. Use with trust.'
};

async function loadFileAccessMode() {
  try {
    const r = await fetch(`${API}/api/security/file-access`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const d = await r.json();
    const sel = document.getElementById('cfg-file-access');
    if (sel) sel.value = d.mode || 'common';
    const hint = document.getElementById('file-access-hint');
    if (hint) hint.textContent = FILE_ACCESS_HINTS[d.mode] || '';
  } catch {}
}

async function setFileAccessMode(mode) {
  const hint = document.getElementById('file-access-hint');
  if (hint) hint.textContent = FILE_ACCESS_HINTS[mode] || '';
  try {
    await fetch(`${API}/api/security/file-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ mode })
    });
  } catch {}
}

// ── API Integrations ──

async function loadIntegrations() {
  const el = document.getElementById('integrations-list');
  if (!el) return;
  try {
    const list = await apiJson('/api/integrations');
    if (!Array.isArray(list) || list.length === 0) { el.innerHTML = '<p style="color:var(--muted)">No integrations available. Restart the server if you just updated.</p>'; return; }
    el.innerHTML = list.map(i => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;background:var(--bg2)">
        <div style="display:flex;align-items:center;gap:10px;flex:1">
          <span style="font-size:1.4rem">${i.icon || '🔌'}</span>
          <div>
            <div style="font-family:var(--mono);font-size:.85rem;font-weight:600;color:var(--text)">${esc(i.name)}</div>
            <div style="font-size:.7rem;color:var(--muted);margin-top:2px">${esc(i.description)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:.65rem;padding:3px 8px;border-radius:4px;background:${i.installed ? 'var(--accent)' : 'var(--border)'};color:${i.installed ? '#000' : 'var(--muted)'}">${i.installed ? 'CONNECTED' : 'NOT SET UP'}</span>
          ${i.installed
            ? `<button class="btn" onclick="testIntegration('${i.id}')" title="Test" style="padding:4px 8px;font-size:.7rem">Test</button>
               <button class="btn" onclick="uninstallIntegration('${i.id}')" title="Disconnect" style="padding:4px 8px;font-size:.7rem;color:var(--danger)">&#10005;</button>`
            : `<button class="btn" onclick="showInstallModal('${i.id}')" style="padding:4px 10px;font-size:.7rem;color:var(--accent)" aria-label="Set up ${esc(i.name)}">Set Up ${esc(i.name)}</button>`
          }
          ${!i.builtin ? `<button class="btn" onclick="deleteIntegration('${i.id}')" title="Remove" style="padding:4px 8px;font-size:.7rem;color:var(--danger)">🗑</button>` : ''}
        </div>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = '<p style="color:var(--danger)">Failed to load integrations.</p>';
  }
}

async function showInstallModal(id) {
  try {
    const config = await apiJson('/api/integrations/' + id);
    const instructions = (config.authInstructions || '').replace(/\n/g, '<br>');
    const html = `
      <div id="install-modal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999" onclick="if(event.target===this)this.remove()">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:500px;width:90%">
          <div style="font-size:1.1rem;font-weight:600;color:var(--text);margin-bottom:4px">${config.icon} Set Up ${esc(config.name)}</div>
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:16px">${esc(config.description)}</div>
          <div style="font-size:.72rem;color:var(--text);line-height:1.8;margin-bottom:16px;padding:12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
            <div style="color:var(--accent);font-weight:600;margin-bottom:6px">How to get your credentials:</div>
            ${instructions}
          </div>
          <div style="margin-bottom:12px">
            <label style="font-size:.72rem;color:var(--muted);display:block;margin-bottom:4px">API Key / Token (${esc(config.secretName)})</label>
            <input type="password" id="install-secret-value" class="field-input" placeholder="Paste your key or token here" style="width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:10px;border-radius:6px;font-family:var(--mono);font-size:.8rem" autocomplete="off"/>
          </div>
          ${config.docsUrl ? `<div style="margin-bottom:16px"><a href="${config.docsUrl}" target="_blank" style="font-size:.72rem;color:var(--accent)">📄 Official API Docs →</a></div>` : ''}
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="action-btn secondary" onclick="document.getElementById('install-modal').remove()">Cancel</button>
            <button class="action-btn primary" onclick="doInstallIntegration('${config.id}')">Connect</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    document.getElementById('install-secret-value')?.focus();
  } catch (e) {
    console.error('Failed to load integration:', e);
  }
}

async function doInstallIntegration(id) {
  const input = document.getElementById('install-secret-value');
  const value = input?.value?.trim();
  if (!value) { alert('Please enter your API key or token.'); return; }
  try {
    await apiPost('/api/integrations/install', { id, secretValue: value });
    document.getElementById('install-modal')?.remove();
    loadIntegrations();
  } catch (e) {
    alert('Install failed: ' + e.message);
  }
}

async function uninstallIntegration(id) {
  if (!confirm('Disconnect this integration? The API key will be removed from your secrets vault.')) return;
  try {
    await apiPost('/api/integrations/uninstall', { id });
    loadIntegrations();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function testIntegration(id) {
  try {
    const r = await apiPost('/api/integrations/test', { id });
    if (r.ok) {
      alert('Connection successful! (HTTP ' + r.status + ')');
    } else {
      alert('Connection failed: ' + (r.error || 'HTTP ' + r.status + ' ' + r.statusText));
    }
  } catch (e) {
    alert('Test failed: ' + e.message);
  }
}

async function deleteIntegration(id) {
  if (!confirm('Remove this custom integration?')) return;
  try {
    await apiFetch('/api/integrations/' + id, { method: 'DELETE' });
    loadIntegrations();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function addCustomIntegration() {
  const id = document.getElementById('int-new-id')?.value?.trim();
  const name = document.getElementById('int-new-name')?.value?.trim();
  const baseUrl = document.getElementById('int-new-url')?.value?.trim();
  const docsUrl = document.getElementById('int-new-docs')?.value?.trim();
  const authType = document.getElementById('int-new-auth')?.value;
  const secretName = document.getElementById('int-new-secret')?.value?.trim()?.toUpperCase()?.replace(/[^A-Z0-9_]/g, '_');
  if (!id || !name || !baseUrl) { alert('ID, Name, and Base URL are required.'); return; }
  try {
    await apiPost('/api/integrations', {
      id, name, description: name + ' API', icon: '🔌',
      authType: authType || 'bearer_token',
      authInstructions: 'Add your API key for ' + name,
      baseUrl, docsUrl: docsUrl || '',
      secretName: secretName || (id.toUpperCase() + '_API_KEY'),
      endpoints: [], headers: {},
    });
    // Clear form
    ['int-new-id','int-new-name','int-new-url','int-new-docs','int-new-secret'].forEach(fid => {
      const el = document.getElementById(fid); if (el) el.value = '';
    });
    loadIntegrations();
  } catch (e) { alert('Failed: ' + e.message); }
}

// ── WhatsApp Bridge ──

let _waPollTimer = null;

async function waCheckStatus() {
  try {
    const d = await apiJson('/api/whatsapp/status');
    const stateEl = document.getElementById('wa-state');
    const phoneEl = document.getElementById('wa-phone');
    const badgeEl = document.getElementById('wa-badge');
    const errorEl = document.getElementById('wa-error');
    const qrBox = document.getElementById('wa-qr-box');
    const connectBtn = document.getElementById('wa-connect-btn');
    const disconnectBtn = document.getElementById('wa-disconnect-btn');
    if (!stateEl) return d;

    errorEl && (errorEl.style.display = 'none');

    if (d.state === 'connected') {
      stateEl.textContent = 'Connected';
      stateEl.style.color = 'var(--accent)';
      phoneEl.textContent = d.phone ? '+' + d.phone : '';
      badgeEl.textContent = 'CONNECTED';
      badgeEl.style.background = 'var(--accent)'; badgeEl.style.color = '#000';
      if (qrBox) qrBox.style.display = 'none';
      if (connectBtn) connectBtn.style.display = 'none';
      if (disconnectBtn) disconnectBtn.style.display = '';
      waStopPoll();
    } else if (d.state === 'qr' && (d.qrImageUrl || d.qr)) {
      stateEl.textContent = 'Scan QR Code';
      stateEl.style.color = 'var(--warn)';
      phoneEl.textContent = 'Waiting for scan...';
      badgeEl.textContent = 'SCAN ME'; badgeEl.style.background = 'var(--warn)'; badgeEl.style.color = '#000';
      if (qrBox) qrBox.style.display = '';
      if (connectBtn) connectBtn.style.display = 'none';
      if (disconnectBtn) disconnectBtn.style.display = '';
      // Show QR as image (rendered server-side)
      const img = document.getElementById('wa-qr-img');
      if (img && d.qrImageUrl) img.src = d.qrImageUrl;
      waStartPoll();
    } else if (d.state === 'disconnected') {
      stateEl.textContent = 'Disconnected'; stateEl.style.color = 'var(--muted)';
      phoneEl.textContent = d.hasSavedSession ? 'Saved session — click Connect to resume' : 'Not set up';
      badgeEl.textContent = 'OFF'; badgeEl.style.background = 'var(--border)'; badgeEl.style.color = 'var(--muted)';
      if (qrBox) qrBox.style.display = 'none';
      if (connectBtn) connectBtn.style.display = '';
      if (disconnectBtn) disconnectBtn.style.display = 'none';
      if (d.error && errorEl) { errorEl.textContent = d.error; errorEl.style.display = ''; }
      waStopPoll();
    } else {
      stateEl.textContent = 'Connecting...'; stateEl.style.color = 'var(--info)';
      phoneEl.textContent = '';
      badgeEl.textContent = 'CONNECTING'; badgeEl.style.background = 'var(--info)'; badgeEl.style.color = '#000';
      if (connectBtn) connectBtn.style.display = 'none';
      waStartPoll();
    }
    return d;
  } catch (e) {
    // Stop polling if we get auth errors (prevents 401 spam)
    waStopPoll();
    return null;
  }
}

function waStartPoll() {
  if (_waPollTimer) return;
  _waPollTimer = setInterval(waCheckStatus, 3000);
  setTimeout(() => waStopPoll(), 120000); // stop after 2 min
}
function waStopPoll() {
  if (_waPollTimer) { clearInterval(_waPollTimer); _waPollTimer = null; }
}

async function waConnect() {
  const btn = document.getElementById('wa-connect-btn');
  if (btn) { btn.textContent = 'Connecting...'; btn.disabled = true; }
  try {
    await apiPost('/api/whatsapp/connect', {});
    waStartPoll();
    await waCheckStatus();
  } catch (e) {
    console.error('WhatsApp connect failed:', e);
  }
  if (btn) { btn.textContent = 'Connect'; btn.disabled = false; }
}

async function waDisconnect() {
  if (!confirm('Disconnect WhatsApp?')) return;
  try { await apiPost('/api/whatsapp/disconnect', {}); } catch {}
  await waCheckStatus();
}

async function waReset() {
  if (!confirm('Clear saved session? You will need to scan QR again.')) return;
  try {
    console.log('[wa] Resetting...');
    await apiPost('/api/whatsapp/reset', {});
    console.log('[wa] Reset done');
  } catch (e) {
    console.error('[wa] Reset failed:', e);
  }
  await waCheckStatus();
}

async function waTestConnect() {
  // Debug function — call from browser console: waTestConnect()
  console.log('[wa] Testing connect...');
  try {
    const r = await fetch('/api/whatsapp/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AUTH_TOKEN },
      body: '{}',
    });
    console.log('[wa] Response status:', r.status);
    const d = await r.json();
    console.log('[wa] Response:', d);
  } catch (e) {
    console.error('[wa] Failed:', e);
  }
}

// ── HTTPS ──

// ── Auto-init ──
// Call init_settings when the script loads (fixes integrations not loading)
if (document.getElementById('integrations-list')) {
  init_settings();
}

