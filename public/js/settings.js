// ── Settings Panel ──

function init_settings() {
  loadSettings();
  loadSyncConfig();
  checkSettingsAuth();
  checkServer('image');
  checkServer('video');
  checkVoiceCaps();
  loadToolsList();
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

async function saveSettings() {
  const s = {
    provider: document.getElementById('cfg-provider')?.value,
    model: document.getElementById('cfg-model')?.value,
    temperature: parseFloat(document.getElementById('cfg-temperature')?.value || '0.7'),
    imageEngine: document.getElementById('cfg-image-engine')?.value,
    sttEngine: document.getElementById('cfg-stt-engine')?.value,
    ttsEngine: document.getElementById('cfg-tts-engine')?.value,
    ttsVoice: document.getElementById('cfg-tts-voice')?.value,
    sandbox: document.getElementById('cfg-sandbox')?.value,
  };
  localStorage.setItem('sax_settings', JSON.stringify(s));
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
  } catch {}
  checkSyncStatus();
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

  // Save token to secrets vault if provided
  if (token) {
    await apiPost('/api/secrets', { name: 'GITHUB_SYNC_TOKEN', value: token, service: 'GitHub Sync' });
    document.getElementById('cfg-sync-token').value = ''; // Clear from UI
  }

  await apiPost('/api/sync/configure', { enabled, repoUrl: repo, interval, autoDownload, syncSessions, syncWorkspace });
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
