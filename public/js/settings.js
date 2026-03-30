// ── Settings Panel ──

async function settingsCheckUpdate() {
  const status = document.getElementById('settings-update-status');
  if (!status) return;
  status.style.color = 'var(--muted)';
  status.textContent = 'Checking...';
  try {
    const res = await apiFetch('/api/updates/check');
    const data = await res.json();
    if (data.updateAvailable) {
      status.style.color = 'var(--accent)';
      status.innerHTML = `Update available: v${esc(data.remoteVersion)}${data.remoteCommit ? ' (' + esc(data.remoteCommit) + ')' : ''}${data.releaseNotes ? ' — ' + esc(data.releaseNotes) : ''} <a href="https://github.com/petermanrique101-sys/Open-Agent-X" target="_blank" style="color:var(--accent);margin-left:8px">View on GitHub</a>`;
    } else {
      status.style.color = 'var(--accent)';
      status.textContent = 'You are up to date! (v' + (data.localVersion || '0.1.0') + ')';
    }
  } catch (e) {
    status.style.color = 'var(--error, red)';
    status.textContent = 'Could not check for updates.';
  }
}

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
  loadSelfModify();
  loadIntegrations();
  waCheckStatus();
  tgCheckStatus();
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
    const cliEl = document.getElementById('claude-cli-status');
    const cliBtn = document.getElementById('btn-install-claude-cli');
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
    // Claude CLI status
    if (cliEl) {
      if (d.cliInstalled) {
        cliEl.className = 'status-badge ok';
        cliEl.innerHTML = '<span class="status-dot"></span> Claude CLI installed';
        if (cliBtn) cliBtn.style.display = 'none';
      } else {
        cliEl.className = 'status-badge err';
        cliEl.innerHTML = '<span class="status-dot"></span> Claude CLI not found — required for Claude to work';
        if (cliBtn) cliBtn.style.display = '';
      }
    }
  } catch {}
}

async function installClaudeCli() {
  const btn = document.getElementById('btn-install-claude-cli');
  const cliEl = document.getElementById('claude-cli-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Installing...'; }
  if (cliEl) { cliEl.className = 'status-badge warn'; cliEl.innerHTML = '<span class="status-dot"></span> Installing Claude CLI via npm... this may take a minute'; }
  try {
    const d = await apiPost('/api/auth/anthropic/install-cli', {});
    if (d.ok) {
      if (cliEl) { cliEl.className = 'status-badge ok'; cliEl.innerHTML = '<span class="status-dot"></span> Claude CLI installed — ' + (d.version || 'ready'); }
      if (btn) btn.style.display = 'none';
    } else {
      throw new Error(d.error || 'Unknown error');
    }
  } catch (e) {
    if (cliEl) { cliEl.className = 'status-badge err'; cliEl.innerHTML = '<span class="status-dot"></span> Install failed: ' + esc(e.message); }
    if (btn) { btn.disabled = false; btn.textContent = 'Retry Install'; }
  }
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
    el.className = 'status-badge ok'; el.innerHTML = `<span class="status-dot"></span> Running — ${esc(d.device || 'ready')}`;
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
    // Override with user's saved preference (capabilities shows auto-detected, but user may have chosen differently)
    const saved = JSON.parse(localStorage.getItem('sax_settings') || '{}');
    const userEngine = saved.ttsEngine || d.tts;
    const userVoice = userEngine === 'xtts' ? (saved.xttsVoice || 'clone') : (saved.ttsVoice || d.ttsVoice);
    const stt = document.getElementById('stt-status'), tts = document.getElementById('tts-status');
    if (stt) { stt.className = d.stt !== 'none' ? 'status-badge ok' : 'status-badge err'; stt.innerHTML = `<span class="status-dot"></span> ${d.stt !== 'none' ? 'Whisper (' + esc(d.whisperModel) + ')' : 'Not available'}`; }
    if (tts) { tts.className = userEngine !== 'none' ? 'status-badge ok' : 'status-badge err'; tts.innerHTML = `<span class="status-dot"></span> ${userEngine !== 'none' ? esc(userEngine) + ' (' + esc(userVoice) + ')' : 'Not available'}`; }
  } catch {}
}

function loadToolsList() {
  const tools = [
    { name: 'read', status: 'allowed' }, { name: 'write', status: 'allowed' }, { name: 'edit', status: 'allowed' },
    { name: 'bash', status: 'rate-limited' },
    { name: 'web_fetch', status: 'rate-limited' }, { name: 'web_search', status: 'allowed' },
    { name: 'http_request', status: 'rate-limited' }, { name: 'browser', status: 'rate-limited' },
    { name: 'generate_image', status: 'rate-limited' }, { name: 'generate_video', status: 'rate-limited' },
    { name: 'memory_search', status: 'allowed' }, { name: 'memory_save', status: 'allowed' },
    { name: 'memory_get', status: 'allowed' }, { name: 'memory_recall', status: 'allowed' },
    { name: 'memory_reflect', status: 'allowed' }, { name: 'memory_update_profile', status: 'allowed' },
    { name: 'memory_stats', status: 'allowed' }, { name: 'request_secret', status: 'allowed' },
    { name: 'mission_list', status: 'allowed' }, { name: 'mission_get', status: 'allowed' },
    { name: 'mission_save_preference', status: 'allowed' }, { name: 'mission_format_caption', status: 'allowed' },
    { name: 'cron_list', status: 'allowed' }, { name: 'cron_create', status: 'allowed' },
    { name: 'cron_delete', status: 'allowed' }, { name: 'cron_toggle', status: 'allowed' },
  ];
  const el = document.getElementById('tools-list'); if (!el) return;
  el.innerHTML = tools.map(t => {
    const color = t.status === 'allowed' ? 'var(--accent)' : t.status === 'rate-limited' ? 'var(--warn)' : 'var(--info)';
    return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text)">${t.name}</span><span style="color:${color}">${t.status}</span></div>`;
  }).join('');
}

// ── API Key management per provider ──

const PROVIDER_KEY_CONFIG = {
  xai: { label: 'xAI API Key', placeholder: 'xai-...', hint: 'Get your key at console.x.ai', secretName: 'XAI_API_KEY' },
  gemini: { label: 'Google API Key', placeholder: 'AIza...', hint: 'Get your key at ai.google.dev', secretName: 'GEMINI_API_KEY' },
  openai: { label: 'OpenAI API Key', placeholder: 'sk-...', hint: 'Get your key at platform.openai.com/api-keys', secretName: 'OPENAI_API_KEY' },
  custom: { label: 'API Key', placeholder: 'Enter API key...', hint: 'Key for your custom OpenAI-compatible provider', secretName: 'CUSTOM_API_KEY' },
};

function updateApiKeyField(provider) {
  const field = document.getElementById('api-key-field');
  const label = document.getElementById('api-key-label');
  const input = document.getElementById('cfg-api-key');
  const hint = document.getElementById('api-key-hint');
  const status = document.getElementById('api-key-status');
  if (!field) return;

  const config = PROVIDER_KEY_CONFIG[provider];
  if (!config) {
    field.style.display = 'none';
    return;
  }

  field.style.display = '';
  if (label) label.textContent = config.label;
  if (input) input.placeholder = config.placeholder;
  if (hint) hint.textContent = config.hint;
  if (status) status.innerHTML = '';

  // Check if key exists in secrets store
  if (input) {
    input.value = '';
    input.dataset.provider = provider;
    apiJson('/api/secrets').then(secrets => {
      const exists = Array.isArray(secrets) && secrets.some(s => s.name === config.secretName);
      if (exists) {
        input.placeholder = '••••••••  (saved — enter new value to replace)';
        if (status) { status.className = 'status-badge ok'; status.innerHTML = '<span class="status-dot"></span> Key saved securely'; }
      }
    }).catch(() => {});
  }
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('cfg-api-key');
  const btn = document.getElementById('btn-toggle-key');
  if (!input) return;
  if (input.type === 'password') { input.type = 'text'; if (btn) btn.textContent = 'Hide'; }
  else { input.type = 'password'; if (btn) btn.textContent = 'Show'; }
}

// ── Provider change → toggle model input vs dropdown ──

const PROVIDER_MODELS = {
  codex: [
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex (default)' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4-mini' },
  ],
  anthropic: [
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (default)' },
    { value: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
    { value: 'claude-haiku-4-20250514', label: 'Claude Haiku 4' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  ],
  xai: [
    { value: 'grok-3-mini', label: 'Grok 3 Mini (default)' },
    { value: 'grok-3', label: 'Grok 3' },
    { value: 'grok-2', label: 'Grok 2' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o (default)' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4-mini' },
  ],
  gemini: [
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (default)' },
    { value: 'gemini-2.5-pro-preview-05-06', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  ],
};

async function onProviderChange(provider, keepModel) {
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
    const models = PROVIDER_MODELS[provider] || [];
    if (models.length) {
      modelSelect.style.display = '';
      modelInput.style.display = 'none';
      modelSelect.innerHTML = models.map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('') +
        '<option value="__custom__">Custom model...</option>';
      // Restore saved model if it matches, otherwise use default
      if (keepModel) {
        const saved = modelInput.value || modelInput.dataset.saved;
        const match = models.find(m => m.value === saved);
        if (match) modelSelect.value = saved;
        else if (saved && saved !== '__custom__') {
          // Custom model was saved — show it
          modelSelect.value = '__custom__';
          modelInput.style.display = '';
          modelInput.value = saved;
        }
      }
      modelSelect.onchange = () => {
        if (modelSelect.value === '__custom__') {
          modelInput.style.display = '';
          modelInput.value = '';
          modelInput.focus();
        } else {
          modelInput.style.display = 'none';
          modelInput.value = modelSelect.value;
        }
      };
      // Sync hidden input with dropdown
      if (modelSelect.value !== '__custom__') modelInput.value = modelSelect.value;
    } else {
      modelSelect.style.display = 'none';
      modelInput.style.display = '';
    }
    if (ollamaStatus) ollamaStatus.style.display = 'none';
    if (hint) {
      if (provider === 'custom') hint.innerHTML = 'Enter the model name from your provider. <br><label class="field-label" style="margin-top:8px">Base URL</label><input class="field-input" id="cfg-custom-url" placeholder="https://api.example.com/v1" value="" style="margin-top:4px" /><div style="font-size:.6rem;color:var(--muted);margin-top:4px">Any OpenAI-compatible API endpoint (e.g. https://api.deepseek.com/v1)</div>';
      else hint.textContent = '';
    }
  }
  updateApiKeyField(provider);
  // Load custom base URL if saved
  if (provider === 'custom') {
    try { const r = await apiFetch('/api/settings'); const s = await r.json(); const el = document.getElementById('cfg-custom-url'); if (el && s.customBaseUrl) el.value = s.customBaseUrl; } catch {}
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
      return `<option value="${esc(m.name)}">${esc(m.name)}${sizeGB ? ' (' + sizeGB + ')' : ''}</option>`;
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
  const model = provider === 'local' ? modelSelect?.value :
    (modelSelect?.value === '__custom__' || modelSelect?.style.display === 'none') ? modelInput?.value : (modelSelect?.value || modelInput?.value);
  const portVal = document.getElementById('cfg-port')?.value;
  const s = {
    provider,
    model,
    temperature: parseFloat(document.getElementById('cfg-temperature')?.value || '0.7'),
    port: portVal ? parseInt(portVal, 10) : undefined,
    imageEngine: document.getElementById('cfg-image-engine')?.value,
    sttEngine: document.getElementById('cfg-stt-engine')?.value,
    ttsEngine: document.getElementById('cfg-tts-engine')?.value,
    ttsVoice: document.getElementById('cfg-tts-voice')?.value,
    xttsVoice: document.getElementById('cfg-xtts-voice')?.value,
    sandbox: document.getElementById('cfg-sandbox')?.value,
  };
  localStorage.setItem('sax_settings', JSON.stringify(s));
  // Save API key to encrypted secrets store (never plain settings.json)
  const apiKeyInput = document.getElementById('cfg-api-key');
  const apiKeyStatus = document.getElementById('api-key-status');
  if (apiKeyInput && apiKeyInput.value && PROVIDER_KEY_CONFIG[provider]) {
    try {
      await apiPost('/api/secrets', { name: PROVIDER_KEY_CONFIG[provider].secretName, value: apiKeyInput.value });
      localStorage.setItem('sax_apikey_' + provider, 'saved'); // flag only, not the actual key
      if (apiKeyStatus) { apiKeyStatus.className = 'status-badge ok'; apiKeyStatus.innerHTML = '<span class="status-dot"></span> Key saved securely'; }
    } catch (e) {
      if (apiKeyStatus) { apiKeyStatus.className = 'status-badge err'; apiKeyStatus.innerHTML = '<span class="status-dot"></span> Failed to save key'; }
    }
  }
  // Save provider + model to server (no API key in settings.json)
  const currentPort = location.port || '7007';
  const settingsPayload = { provider: s.provider, model: s.model, temperature: s.temperature };
  if (s.port) settingsPayload.port = s.port;
  const customUrl = document.getElementById('cfg-custom-url');
  if (customUrl && customUrl.value) settingsPayload.customBaseUrl = customUrl.value;
  await apiPost('/api/settings', settingsPayload);
  // If port changed, tell user to restart the app
  if (s.port && String(s.port) !== String(currentPort)) {
    alert('Port changed to ' + s.port + '. Please quit and relaunch Open Agent X for this to take effect.');
  }
  // Also save sync config to server
  await saveSyncConfig();
  const el = document.getElementById('save-status');
  if (el) { el.textContent = 'Saved'; setTimeout(() => el.textContent = '', 2000); }
}

async function loadSettings() {
  try {
    // Server is the source of truth — localStorage is just a cache
    let serverSettings = {};
    try { const r = await apiFetch('/api/settings'); serverSettings = await r.json(); } catch {}
    const local = JSON.parse(localStorage.getItem('sax_settings') || '{}');
    const s = { ...local, ...serverSettings };
    // Sync localStorage with server (so they don't fight)
    localStorage.setItem('sax_settings', JSON.stringify(s));
    const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
    set('cfg-port', s.port);
    set('cfg-provider', s.provider); set('cfg-model', s.model); set('cfg-temperature', s.temperature);
    // Store saved model and trigger provider change to populate dropdown
    const modelInput = document.getElementById('cfg-model');
    if (modelInput && s.model) modelInput.dataset.saved = s.model;
    if (s.provider) onProviderChange(s.provider, true);
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
              <button class="btn" onclick="previewVoice('${esc(v.id)}')" title="Preview" style="padding:4px 8px;font-size:.75rem">&#9654;</button>
              <span style="font-family:var(--mono);font-size:.8rem">${esc(v.name)}</span>
              <span style="color:var(--muted);font-size:.7rem">${Math.round(v.size/1024)}KB</span>
            </div>
            <button class="btn" onclick="deleteVoice('${esc(v.id)}')" title="Delete" style="padding:4px 8px;font-size:.75rem;color:var(--danger)">&#10005;</button>
          </div>
        `).join('');
      }
    }
  } catch {
    sel.innerHTML = '<option value="">XTTS server not running</option>';
    if (list) list.innerHTML = '<div style="display:flex;align-items:center;gap:10px"><span style="color:var(--danger);font-size:.75rem">XTTS server not running</span><button class="btn" onclick="startXttsServer()" id="start-xtts-btn" style="padding:4px 12px;font-size:.72rem;color:var(--accent)">Start XTTS Server</button></div>';
  }
}

/** Convert WebM/Opus blob to WAV blob using Web Audio API */
async function webmToWav(webmBlob) {
  const arrayBuf = await webmBlob.arrayBuffer();
  const actx = new OfflineAudioContext(1, 1, 44100);
  let audioBuf;
  try {
    audioBuf = await actx.decodeAudioData(arrayBuf);
  } catch {
    // If decode fails, return original blob
    return webmBlob;
  }
  const numCh = audioBuf.numberOfChannels;
  const length = audioBuf.length;
  const sampleRate = audioBuf.sampleRate;
  const bytesPerSample = 2; // 16-bit PCM
  const dataSize = length * numCh * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  // WAV header
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * bytesPerSample, true);
  view.setUint16(32, numCh * bytesPerSample, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, dataSize, true);
  // PCM samples
  let offset = 44;
  const channels = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(audioBuf.getChannelData(ch));
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

let _vizAnimFrame = null;
let _vizCtx = null;
let _vizAnalyser = null;

function startVisualizer(stream) {
  const canvas = document.getElementById('voice-visualizer');
  if (!canvas) return;
  canvas.style.display = 'block';
  _vizCtx = canvas.getContext('2d');
  const actx = new AudioContext();
  const src = actx.createMediaStreamSource(stream);
  _vizAnalyser = actx.createAnalyser();
  _vizAnalyser.fftSize = 64;
  src.connect(_vizAnalyser);
  const data = new Uint8Array(_vizAnalyser.frequencyBinCount);
  function draw() {
    _vizAnimFrame = requestAnimationFrame(draw);
    _vizAnalyser.getByteFrequencyData(data);
    const w = canvas.width, h = canvas.height;
    _vizCtx.clearRect(0, 0, w, h);
    const bars = 16;
    const barW = (w / bars) - 2;
    for (let i = 0; i < bars; i++) {
      const v = data[i] / 255;
      const barH = Math.max(2, v * h);
      const x = i * (barW + 2);
      const hue = 120 + i * 8;
      _vizCtx.fillStyle = `hsl(${hue}, 80%, ${50 + v * 20}%)`;
      _vizCtx.fillRect(x, h - barH, barW, barH);
    }
  }
  draw();
}

function stopVisualizer() {
  if (_vizAnimFrame) cancelAnimationFrame(_vizAnimFrame);
  _vizAnimFrame = null;
  const canvas = document.getElementById('voice-visualizer');
  if (canvas) { canvas.style.display = 'none'; }
}

async function toggleVoiceRecording() {
  const btn = document.getElementById('record-voice-btn');
  const status = document.getElementById('record-status');
  if (_voiceRecorder && _voiceRecorder.state === 'recording') {
    _voiceRecorder.stop();
    stopVisualizer();
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
      const webmBlob = new Blob(_voiceChunks, { type: 'audio/webm' });
      // Convert WebM to WAV for XTTS compatibility and playback
      const wavBlob = await webmToWav(webmBlob);
      await sendVoiceSample(wavBlob);
    };
    _voiceRecorder.start();
    startVisualizer(stream);
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
    // Keep original format extension (webm from browser recording, wav/mp3 from uploads)
    const ext = blob.type?.includes('webm') ? '.webm' : blob.type?.includes('mp3') ? '.mp3' : '.wav';
    formData.append('audio', blob, name + ext);
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
    // Route through our server to avoid CORS issues with XTTS port
    const r = await fetch(`/api/voice/preview/${voiceId}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    if (!r.ok) {
      // Fallback: try XTTS directly
      const r2 = await fetch(`${XTTS_URL}/voices/${voiceId}/preview`);
      const blob = await r2.blob();
      const audio = new Audio(URL.createObjectURL(new Blob([blob], { type: 'audio/wav' })));
      await audio.play();
      return;
    }
    const blob = await r.blob();
    const audio = new Audio(URL.createObjectURL(blob));
    await audio.play();
  } catch (e) { console.error('Preview failed:', e); }
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

// ── Self-Modify Mode ──

async function loadSelfModify() {
  try {
    const r = await fetch(`${API}/api/security/self-modify`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const d = await r.json();
    const cb = document.getElementById('cfg-self-modify');
    if (cb) cb.checked = !!d.enabled;
    const hint = document.getElementById('self-modify-hint');
    if (hint) hint.textContent = d.enabled
      ? 'Enabled. The agent can modify non-core src/ files and hot-reload changes.'
      : 'Disabled. The agent cannot write to src/ files.';
  } catch {}
}

async function setSelfModify(enabled) {
  const hint = document.getElementById('self-modify-hint');
  if (hint) hint.textContent = enabled
    ? 'Enabled. The agent can modify non-core src/ files and hot-reload changes.'
    : 'Disabled. The agent cannot write to src/ files.';
  try {
    await fetch(`${API}/api/security/self-modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ enabled })
    });
  } catch {}
}

// ── User Mode (Simple / Power) ──

function loadUserMode() {
  const mode = localStorage.getItem('sax_user_mode') || 'power';
  applyUserMode(mode);
}

function setUserMode(mode) {
  localStorage.setItem('sax_user_mode', mode);
  applyUserMode(mode);
  // Persist to server
  try {
    fetch(`${API}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ userMode: mode })
    });
  } catch {}
}

function applyUserMode(mode) {
  const cb = document.getElementById('cfg-user-mode');
  if (cb) cb.checked = mode === 'simple';
  if (mode === 'simple') {
    document.body.classList.add('simple-mode');
  } else {
    document.body.classList.remove('simple-mode');
  }
}

// Load mode immediately
loadUserMode();

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
          <span style="font-size:1.4rem">${esc(i.icon || '🔌')}</span>
          <div>
            <div style="font-family:var(--mono);font-size:.85rem;font-weight:600;color:var(--text)">${esc(i.name)}</div>
            <div style="font-size:.7rem;color:var(--muted);margin-top:2px">${esc(i.description)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:.65rem;padding:3px 8px;border-radius:4px;background:${i.installed ? 'var(--accent)' : 'var(--border)'};color:${i.installed ? '#000' : 'var(--muted)'}">${i.installed ? 'CONNECTED' : 'NOT SET UP'}</span>
          ${i.installed
            ? `<button class="btn" onclick="testIntegration('${esc(i.id)}')" title="Test" style="padding:4px 8px;font-size:.7rem">Test</button>
               <button class="btn" onclick="uninstallIntegration('${esc(i.id)}')" title="Disconnect" style="padding:4px 8px;font-size:.7rem;color:var(--danger)">&#10005;</button>`
            : `<button class="btn" onclick="showInstallModal('${esc(i.id)}')" style="padding:4px 10px;font-size:.7rem;color:var(--accent)" aria-label="Set up ${esc(i.name)}">Set Up ${esc(i.name)}</button>`
          }
          ${!i.builtin ? `<button class="btn" onclick="deleteIntegration('${esc(i.id)}')" title="Remove" style="padding:4px 8px;font-size:.7rem;color:var(--danger)">🗑</button>` : ''}
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
    const instructions = esc(config.authInstructions || '').replace(/\n/g, '<br>');
    const html = `
      <div id="install-modal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999" onclick="if(event.target===this)this.remove()">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:500px;width:90%">
          <div style="font-size:1.1rem;font-weight:600;color:var(--text);margin-bottom:4px">${esc(config.icon)} Set Up ${esc(config.name)}</div>
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:16px">${esc(config.description)}</div>
          <div style="font-size:.72rem;color:var(--text);line-height:1.8;margin-bottom:16px;padding:12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
            <div style="color:var(--accent);font-weight:600;margin-bottom:6px">How to get your credentials:</div>
            ${instructions}
          </div>
          <div style="margin-bottom:12px">
            <label style="font-size:.72rem;color:var(--muted);display:block;margin-bottom:4px">API Key / Token (${esc(config.secretName)})</label>
            <input type="password" id="install-secret-value" class="field-input" placeholder="Paste your key or token here" style="width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:10px;border-radius:6px;font-family:var(--mono);font-size:.8rem" autocomplete="off"/>
          </div>
          ${config.docsUrl ? `<div style="margin-bottom:16px"><a href="${/^https?:\/\//i.test(config.docsUrl || '') ? esc(config.docsUrl) : '#'}" target="_blank" style="font-size:.72rem;color:var(--accent)">📄 Official API Docs →</a></div>` : ''}
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

// ── Telegram Bot ──

async function tgCheckStatus() {
  try {
    const d = await apiJson('/api/telegram/status');
    const stateEl = document.getElementById('tg-state');
    const nameEl = document.getElementById('tg-bot-name');
    const badgeEl = document.getElementById('tg-badge');
    const errorEl = document.getElementById('tg-error');
    const tokenBox = document.getElementById('tg-token-box');
    const connectBtn = document.getElementById('tg-connect-btn');
    const disconnectBtn = document.getElementById('tg-disconnect-btn');
    if (!stateEl) return;

    errorEl && (errorEl.style.display = 'none');

    if (d.state === 'connected') {
      stateEl.textContent = 'Connected';
      stateEl.style.color = 'var(--accent)';
      nameEl.textContent = d.botUsername ? '@' + d.botUsername : d.botName || '';
      badgeEl.textContent = 'CONNECTED'; badgeEl.style.background = 'var(--accent)'; badgeEl.style.color = '#000';
      if (tokenBox) tokenBox.style.display = 'none';
      if (connectBtn) connectBtn.style.display = 'none';
      if (disconnectBtn) disconnectBtn.style.display = '';
    } else if (d.state === 'error') {
      stateEl.textContent = 'Error'; stateEl.style.color = 'var(--danger)';
      nameEl.textContent = '';
      badgeEl.textContent = 'ERROR'; badgeEl.style.background = 'var(--danger)'; badgeEl.style.color = '#fff';
      if (tokenBox) tokenBox.style.display = '';
      if (connectBtn) connectBtn.style.display = '';
      if (disconnectBtn) disconnectBtn.style.display = 'none';
      if (d.error && errorEl) { errorEl.textContent = d.error; errorEl.style.display = ''; }
    } else {
      stateEl.textContent = 'Disconnected'; stateEl.style.color = 'var(--muted)';
      nameEl.textContent = d.hasToken ? 'Token saved — click Connect' : 'Not set up';
      badgeEl.textContent = 'OFF'; badgeEl.style.background = 'var(--border)'; badgeEl.style.color = 'var(--muted)';
      if (tokenBox) tokenBox.style.display = '';
      if (connectBtn) connectBtn.style.display = '';
      if (disconnectBtn) disconnectBtn.style.display = 'none';
      // Show placeholder hint if token is already saved
      const tokenInput = document.getElementById('tg-token-input');
      if (tokenInput && d.hasToken) tokenInput.placeholder = 'Token saved in vault (leave blank to use it)';
    }
  } catch {}
}

async function tgConnect() {
  const tokenInput = document.getElementById('tg-token-input');
  const token = tokenInput?.value?.trim();
  const btn = document.getElementById('tg-connect-btn');
  if (btn) { btn.textContent = 'Connecting...'; btn.disabled = true; }

  try {
    // Save token to secrets vault first (if provided)
    if (token) {
      await apiPost('/api/secrets', { name: 'TELEGRAM_BOT_TOKEN', value: token });
    }
    const d = await apiPost('/api/telegram/connect', {});
    if (d.state === 'error') {
      const errorEl = document.getElementById('tg-error');
      if (errorEl) { errorEl.textContent = d.error || 'Connection failed'; errorEl.style.display = ''; }
    }
    await tgCheckStatus();
  } catch (e) {
    console.error('Telegram connect failed:', e);
  }
  if (btn) { btn.textContent = 'Connect'; btn.disabled = false; }
}

async function tgDisconnect() {
  if (!confirm('Disconnect Telegram bot?')) return;
  try { await apiPost('/api/telegram/disconnect', {}); } catch {}
  await tgCheckStatus();
}

// ── HTTPS ──

// ── Settings Import/Export (feature 98) ──

function exportSettings() {
  const data = {};
  // Collect all sax_ localStorage keys
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('sax_') && !key.includes('token')) {
      try { data[key] = JSON.parse(localStorage.getItem(key)); } catch { data[key] = localStorage.getItem(key); }
    }
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'agent-x-settings-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click(); URL.revokeObjectURL(url);
}

function importSettings() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      let count = 0;
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith('sax_') && !key.includes('token')) {
          localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
          count++;
        }
      }
      alert('Imported ' + count + ' settings. Reloading...');
      location.reload();
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  };
  input.click();
}

// ── Onboarding Wizard (feature 99) ──

async function shouldShowOnboarding() {
  if (localStorage.getItem('sax_onboarded')) return false;
  try {
    // Check server-side onboarded flag
    const r = await apiFetch('/api/settings');
    const s = await r.json();
    if (s.onboarded) { localStorage.setItem('sax_onboarded', '1'); return false; }
    // Check if any AI provider is already configured (skip onboarding)
    const p = await apiFetch('/api/providers');
    const d = await p.json();
    if (d.providers && d.providers.length > 0) {
      localStorage.setItem('sax_onboarded', '1');
      apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onboarded: true }) }).catch(() => {});
      return false;
    }
  } catch {}
  return true;
}

function showOnboarding() {
  const overlay = document.createElement('div');
  overlay.id = 'onboarding-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Welcome wizard');
  overlay.innerHTML = `
    <div id="onboarding-modal">
      <div id="onboarding-steps">
        <div class="onboarding-step active" data-step="0">
          <h2 class="onboarding-title">Welcome to Open Agent X</h2>
          <p class="onboarding-desc">Your personal AI agent that runs locally. Let's get you set up in 3 quick steps.</p>
          <div class="onboarding-art">&#9889;</div>
        </div>
        <div class="onboarding-step" data-step="1">
          <h2 class="onboarding-title">Choose Your AI Provider</h2>
          <p class="onboarding-desc">Select which AI model to use. You can change this later in Settings.</p>
          <div class="onboarding-options">
            <button class="onboarding-option" onclick="selectOnboardProvider('xai')"><strong>xAI Grok</strong><br><span style="color:var(--muted);font-size:.72rem">API key required</span></button>
            <button class="onboarding-option" onclick="selectOnboardProvider('gemini')"><strong>Google Gemini</strong><br><span style="color:var(--muted);font-size:.72rem">API key from ai.google.dev</span></button>
            <button class="onboarding-option" onclick="selectOnboardProvider('codex')"><strong>OpenAI Codex</strong><br><span style="color:var(--muted);font-size:.72rem">Free with ChatGPT</span></button>
            <button class="onboarding-option" onclick="selectOnboardProvider('anthropic')"><strong>Anthropic Claude</strong><br><span style="color:var(--muted);font-size:.72rem">Free for subscribers</span></button>
            <button class="onboarding-option" onclick="selectOnboardProvider('local')"><strong>Local (Ollama)</strong><br><span style="color:var(--muted);font-size:.72rem">Runs on your GPU</span></button>
            <button class="onboarding-option" onclick="selectOnboardProvider('custom')" style="opacity:.7"><strong>Custom Provider</strong><br><span style="color:var(--muted);font-size:.72rem">Any OpenAI-compatible API</span></button>
          </div>
        </div>
        <div class="onboarding-step" data-step="2">
          <h2 class="onboarding-title">Connect Your Account</h2>
          <p class="onboarding-desc" id="ob-connect-desc">Sign in or enter your API key to start chatting.</p>
          <div id="ob-connect-content" style="display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:12px">
            <!-- Populated dynamically based on provider selection -->
          </div>
          <p id="ob-connect-status" style="color:var(--accent);font-size:.8rem;margin-top:8px;text-align:center"></p>
        </div>
        <div class="onboarding-step" data-step="3">
          <h2 class="onboarding-title">Voice Settings</h2>
          <p class="onboarding-desc">Agent X supports hands-free voice chat. Enable it now or later.</p>
          <div class="onboarding-options">
            <button class="onboarding-option" onclick="selectOnboardVoice(true)"><strong>Enable Voice</strong><br><span style="color:var(--muted);font-size:.72rem">Mic + TTS</span></button>
            <button class="onboarding-option" onclick="selectOnboardVoice(false)"><strong>Text Only</strong><br><span style="color:var(--muted);font-size:.72rem">Keyboard input</span></button>
          </div>
        </div>
        <div class="onboarding-step" data-step="4">
          <h2 class="onboarding-title">You're All Set!</h2>
          <p class="onboarding-desc">Start chatting with your agent. Use Ctrl+K anytime to open the command palette.</p>
          <div class="onboarding-art" style="font-size:2.5rem">&#128640;</div>
        </div>
      </div>
      <div class="onboarding-nav">
        <button class="action-btn secondary" id="ob-back" onclick="onboardStep(-1)" style="visibility:hidden">Back</button>
        <div class="onboarding-dots" id="ob-dots"></div>
        <button class="action-btn primary" id="ob-next" onclick="onboardStep(1)">Get Started</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  updateOnboardingUI();
}

let _onboardStep = 0;
let _onboardProvider = '';
const ONBOARD_TOTAL = 5;

function onboardStep(dir) {
  _onboardStep += dir;
  if (_onboardStep >= ONBOARD_TOTAL) { finishOnboarding(); return; }
  if (_onboardStep < 0) _onboardStep = 0;
  updateOnboardingUI();
}

function updateOnboardingUI() {
  document.querySelectorAll('.onboarding-step').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.step) === _onboardStep);
  });
  const back = document.getElementById('ob-back');
  const next = document.getElementById('ob-next');
  const dots = document.getElementById('ob-dots');
  if (back) back.style.visibility = _onboardStep > 0 ? 'visible' : 'hidden';
  if (next) next.textContent = _onboardStep === ONBOARD_TOTAL - 1 ? 'Start Chatting' : (_onboardStep === 0 ? 'Get Started' : 'Next');
  if (dots) dots.innerHTML = Array.from({ length: ONBOARD_TOTAL }, (_, i) => `<span class="ob-dot${i === _onboardStep ? ' active' : ''}"></span>`).join('');

  // Populate connect step when entering step 2
  if (_onboardStep === 2) populateConnectStep();
}

function populateConnectStep() {
  const container = document.getElementById('ob-connect-content');
  const desc = document.getElementById('ob-connect-desc');
  const status = document.getElementById('ob-connect-status');
  if (!container) return;

  if (_onboardProvider === 'codex') {
    desc.textContent = 'Sign in with your OpenAI account to use GPT models for free.';
    container.innerHTML = `
      <button class="action-btn primary" onclick="onboardOAuth('openai')" style="padding:10px 32px;font-size:1rem">Sign In with OpenAI</button>
      <span style="color:var(--muted);font-size:.75rem">Requires a ChatGPT account (free tier works)</span>
    `;
  } else if (_onboardProvider === 'anthropic') {
    desc.textContent = 'Sign in with your Anthropic account to use Claude models.';
    container.innerHTML = `
      <button class="action-btn primary" onclick="onboardOAuth('anthropic')" style="padding:10px 32px;font-size:1rem">Sign In with Claude</button>
      <span style="color:var(--muted);font-size:.75rem">Free for Claude subscribers</span>
    `;
  } else if (_onboardProvider === 'xai') {
    desc.textContent = 'Enter your xAI API key to use Grok models.';
    container.innerHTML = `
      <input type="password" id="ob-api-key" placeholder="xai-..." style="width:100%;max-width:360px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:.9rem">
      <button class="action-btn primary" onclick="onboardSaveKey('xai','XAI_API_KEY')" style="padding:8px 24px">Save Key</button>
      <span style="color:var(--muted);font-size:.75rem">Get your key at console.x.ai</span>
    `;
  } else if (_onboardProvider === 'openai') {
    desc.textContent = 'Enter your OpenAI API key.';
    container.innerHTML = `
      <input type="password" id="ob-api-key" placeholder="sk-..." style="width:100%;max-width:360px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:.9rem">
      <button class="action-btn primary" onclick="onboardSaveKey('openai','OPENAI_API_KEY')" style="padding:8px 24px">Save Key</button>
      <span style="color:var(--muted);font-size:.75rem">Get your key at platform.openai.com/api-keys</span>
    `;
  } else if (_onboardProvider === 'local') {
    desc.textContent = 'Make sure Ollama is running on your machine.';
    container.innerHTML = `
      <span style="color:var(--muted);font-size:.85rem">Ollama should be running at localhost:11434</span>
      <button class="action-btn secondary" onclick="onboardCheckOllama()" style="padding:8px 24px">Check Connection</button>
    `;
  } else {
    desc.textContent = 'Go back and select a provider first.';
    container.innerHTML = '';
  }
  if (status) status.textContent = '';
}

async function onboardOAuth(type) {
  const status = document.getElementById('ob-connect-status');
  try {
    const endpoint = type === 'anthropic' ? '/api/auth/anthropic/login' : '/api/auth/login';
    const res = await apiPost(endpoint, {});
    if (res.authUrl) {
      window.open(res.authUrl, '_blank', 'width=600,height=700');
      if (status) status.textContent = 'Sign-in window opened — complete login there, then click Next.';
    } else if (res.error) {
      if (status) status.textContent = 'Error: ' + res.error;
    }
  } catch (e) {
    if (status) status.textContent = 'Failed to start sign-in. Try again or set up in Settings later.';
  }
}

async function onboardSaveKey(provider, secretName) {
  const input = document.getElementById('ob-api-key');
  const status = document.getElementById('ob-connect-status');
  if (!input || !input.value.trim()) {
    if (status) status.textContent = 'Please enter your API key.';
    return;
  }
  try {
    await apiPost('/api/secrets', { name: secretName, value: input.value.trim() });
    if (status) { status.style.color = 'var(--accent)'; status.textContent = 'Key saved securely! Click Next to continue.'; }
    input.value = '';
    input.placeholder = '••••••••  (saved)';
  } catch (e) {
    if (status) status.textContent = 'Failed to save key. Try again.';
  }
}

async function onboardCheckOllama() {
  const status = document.getElementById('ob-connect-status');
  try {
    const res = await fetch('/api/models/local');
    const data = await res.json();
    if (data && data.length > 0) {
      if (status) { status.style.color = 'var(--accent)'; status.textContent = 'Ollama connected! Found ' + data.length + ' model(s).'; }
    } else {
      if (status) status.textContent = 'Ollama is running but no models found. Run: ollama pull llama3';
    }
  } catch (e) {
    if (status) status.textContent = 'Could not connect to Ollama. Make sure it is running.';
  }
}

function selectOnboardProvider(provider) {
  _onboardProvider = provider;
  document.querySelectorAll('.onboarding-option').forEach(b => b.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
}

function selectOnboardVoice(enabled) {
  document.querySelectorAll('[data-step="3"] .onboarding-option').forEach(b => b.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
}

function finishOnboarding() {
  localStorage.setItem('sax_onboarded', '1');
  // Also save server-side so it survives port changes
  apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onboarded: true }) }).catch(() => {});
  if (_onboardProvider) {
    const defaults = { codex: 'gpt-5.3-codex', anthropic: 'claude-sonnet-4-20250514', xai: 'grok-3-mini', gemini: 'gemini-2.0-flash', local: '', custom: '' };
    const s = JSON.parse(localStorage.getItem('sax_settings') || '{}');
    s.provider = _onboardProvider;
    if (defaults[_onboardProvider]) s.model = defaults[_onboardProvider];
    localStorage.setItem('sax_settings', JSON.stringify(s));
    apiPost('/api/settings', { provider: s.provider, model: s.model }).catch(() => {});
  }
  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) overlay.remove();
  newChat();
}

// ── Auto-init ──
// Call init_settings when the script loads (fixes integrations not loading)
if (document.getElementById('integrations-list')) {
  init_settings();
}

// Show onboarding on first run
shouldShowOnboarding().then(show => {
  if (show) setTimeout(showOnboarding, 500);
});

