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
  // loadSelfModify removed — platform files always protected
  loadIntegrations();
  waCheckStatus();
  tgCheckStatus();
}

function switchTab(id) {
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-pill').forEach(el => el.classList.remove('active'));
  const pane = document.getElementById('stab-' + id); if (pane) pane.classList.add('active');
  if (event?.target) event.target.classList.add('active');
  if (id === 'image' && typeof refreshVoiceSetup === 'function') refreshVoiceSetup();
}

function toggleSwitch(el) { el.classList.toggle('on'); }

async function checkSettingsAuth() {
  try {
    const d = await apiJson('/api/auth/status');
    const el = document.getElementById('auth-status');
    const loginBtn = document.getElementById('btn-login');
    const discBtn = document.getElementById('btn-disconnect');
    const cliEl = document.getElementById('codex-cli-status');
    const cliBtn = document.getElementById('btn-install-codex-cli');
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
    // Codex CLI status — needed for reliable app building via Codex provider
    if (cliEl) {
      if (d.cliInstalled) {
        cliEl.className = 'status-badge ok';
        cliEl.innerHTML = '<span class="status-dot"></span> Codex CLI installed — app builder will use subprocess for reliable large file writes';
        if (cliBtn) cliBtn.style.display = 'none';
      } else {
        cliEl.className = 'status-badge err';
        cliEl.innerHTML = '<span class="status-dot"></span> Codex CLI not found — install it for reliable app building via Codex (otherwise falls back to Claude CLI)';
        if (cliBtn) cliBtn.style.display = '';
      }
    }
  } catch {}
}

async function installCodexCli() {
  const btn = document.getElementById('btn-install-codex-cli');
  const cliEl = document.getElementById('codex-cli-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Installing...'; }
  if (cliEl) { cliEl.className = 'status-badge warn'; cliEl.innerHTML = '<span class="status-dot"></span> Installing Codex CLI via npm... this may take a minute'; }
  try {
    const d = await apiPost('/api/auth/openai/install-cli', {});
    if (d.ok) {
      if (cliEl) { cliEl.className = 'status-badge ok'; cliEl.innerHTML = '<span class="status-dot"></span> Codex CLI installed — ' + (d.version || 'ready'); }
      if (btn) btn.style.display = 'none';
    } else {
      throw new Error(d.error || 'Unknown error');
    }
  } catch (e) {
    if (cliEl) { cliEl.className = 'status-badge err'; cliEl.innerHTML = '<span class="status-dot"></span> Install failed: ' + esc(e.message); }
    if (btn) { btn.disabled = false; btn.textContent = 'Retry Install'; }
  }
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
    // CLI session is always "valid" — its auth is managed by the CLI, not us
    const usingCliSession = d.method === 'cli-session';
    const hasValidAuth = d.authenticated && (usingCliSession || !d.expired);
    const alreadyHint = document.getElementById('anthropic-already-connected');
    const optionsBlock = document.getElementById('anthropic-options');
    if (hasValidAuth) {
      el.className = 'status-badge ok';
      const label =
        d.method === 'token' ? 'Connected — Setup-token (routes through CLI subprocess)' :
        usingCliSession ? 'Connected — Claude CLI login (Sonnet/Opus/Haiku via subprocess)' :
        'Connected — Anthropic OAuth (legacy, routes through CLI subprocess)';
      el.innerHTML = '<span class="status-dot"></span> ' + label;
      if (loginBtn) { loginBtn.textContent = 'Sign in with Anthropic OAuth'; loginBtn.disabled = false; }
      if (discBtn) discBtn.style.display = usingCliSession ? 'none' : '';
      // CLI-session users don't need to do anything — show the success hint and collapse the options
      if (usingCliSession) {
        if (alreadyHint) alreadyHint.style.display = '';
        if (optionsBlock) optionsBlock.style.display = 'none';
      } else {
        if (alreadyHint) alreadyHint.style.display = 'none';
        if (optionsBlock) optionsBlock.style.display = '';
      }
    } else {
      el.className = 'status-badge err';
      el.innerHTML = '<span class="status-dot"></span> Not connected';
      if (loginBtn) { loginBtn.textContent = 'Sign in with Anthropic OAuth'; loginBtn.disabled = false; }
      if (discBtn) discBtn.style.display = 'none';
      if (alreadyHint) alreadyHint.style.display = 'none';
      if (optionsBlock) optionsBlock.style.display = '';
    }
    // Claude CLI status
    if (cliEl) {
      if (d.cliInstalled) {
        cliEl.className = 'status-badge ok';
        cliEl.innerHTML = '<span class="status-dot"></span> Claude CLI installed — required for all Anthropic auth paths';
        if (cliBtn) cliBtn.style.display = 'none';
      } else {
        cliEl.className = 'status-badge err';
        cliEl.innerHTML = '<span class="status-dot"></span> Claude CLI not found — install it (required for all Anthropic auth)';
        if (cliBtn) cliBtn.style.display = '';
      }
    }
  } catch {}
}

async function saveAnthropicSetupToken() {
  const input = document.getElementById('anthropic-setup-token');
  const btn = document.getElementById('btn-anthropic-save-token');
  const el = document.getElementById('anthropic-auth-status');
  if (!input || !btn) return;
  const token = String(input.value || '').trim();
  if (!token) {
    if (el) { el.className = 'status-badge err'; el.innerHTML = '<span class="status-dot"></span> Paste a Claude setup-token first'; }
    return;
  }
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Saving...';
  try {
    await apiPost('/api/auth/anthropic/setup-token', { token });
    input.value = '';
    await checkAnthropicAuth();
  } catch (e) {
    if (el) { el.className = 'status-badge err'; el.innerHTML = '<span class="status-dot"></span> ' + esc(e.message || 'Failed to save token'); }
  } finally {
    btn.disabled = false;
    btn.textContent = prev || 'Save Token';
  }
}

function toggleAnthropicOptions() {
  const opts = document.getElementById('anthropic-options');
  if (!opts) return;
  opts.style.display = opts.style.display === 'none' ? '' : 'none';
}

let _claudeCliLoginPoll = null;
async function doClaudeCliLogin() {
  const btn = document.getElementById('btn-anthropic-cli-login');
  const cancelBtn = document.getElementById('btn-anthropic-cli-login-cancel');
  const status = document.getElementById('anthropic-cli-login-status');
  if (!btn || !status) return;
  btn.disabled = true; btn.textContent = 'Starting...';
  status.innerHTML = 'Launching <code>claude login</code>...';
  try {
    const d = await apiPost('/api/auth/anthropic/cli-login', {});
    if (!d.authUrl) throw new Error(d.error || 'No URL returned');
    status.innerHTML = '<strong>Click to sign in:</strong> <a href="' + esc(d.authUrl) + '" target="_blank" rel="noopener">' + esc(d.authUrl) + '</a><br><span style="color:var(--muted)">Complete the flow in your browser. We\'ll detect when login finishes.</span>';
    btn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = '';
    // Poll status until cliAuthenticated flips true
    if (_claudeCliLoginPoll) clearInterval(_claudeCliLoginPoll);
    const started = Date.now();
    _claudeCliLoginPoll = setInterval(async () => {
      try {
        const s = await apiJson('/api/auth/anthropic/status');
        if (s.cliAuthenticated) {
          clearInterval(_claudeCliLoginPoll); _claudeCliLoginPoll = null;
          status.innerHTML = '<span style="color:var(--accent)">✓ Signed in via Claude CLI. Chat &amp; builds will route through the CLI subprocess.</span>';
          if (cancelBtn) cancelBtn.style.display = 'none';
          btn.style.display = ''; btn.disabled = false; btn.textContent = 'Re-sign in';
          checkAnthropicAuth();
        } else if (Date.now() - started > 5 * 60 * 1000) {
          clearInterval(_claudeCliLoginPoll); _claudeCliLoginPoll = null;
          status.innerHTML = '<span style="color:var(--err,#c33)">Login timed out (5 min). Try again.</span>';
          if (cancelBtn) cancelBtn.style.display = 'none';
          btn.style.display = ''; btn.disabled = false; btn.textContent = 'Sign in via Claude CLI';
        }
      } catch {}
    }, 2000);
  } catch (e) {
    status.innerHTML = '<span style="color:var(--err,#c33)">' + esc(e.message || 'Login failed') + '</span>';
    btn.disabled = false; btn.textContent = 'Sign in via Claude CLI';
  }
}

async function cancelClaudeCliLogin() {
  const btn = document.getElementById('btn-anthropic-cli-login');
  const cancelBtn = document.getElementById('btn-anthropic-cli-login-cancel');
  const status = document.getElementById('anthropic-cli-login-status');
  if (_claudeCliLoginPoll) { clearInterval(_claudeCliLoginPoll); _claudeCliLoginPoll = null; }
  try { await apiPost('/api/auth/anthropic/cli-login-cancel', {}); } catch {}
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Sign in via Claude CLI'; }
  if (status) status.innerHTML = 'Cancelled. Click to try again.';
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
  if (!confirm('Disconnect from Anthropic and remove the saved setup-token or OAuth session?')) return;
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
  // The old /api/voice/capabilities endpoint and the standalone XTTS/Whisper
  // local servers (ports 7860/7861/7862) are gone — voice now flows through
  // /ws/voice with the GPU sidecar. Show static status badges based on the
  // user's saved voice preference (the live picker on the chat page is the
  // source of truth for what's actually selected).
  try {
    const saved = JSON.parse(localStorage.getItem('sax_settings') || '{}');
    const voice = localStorage.getItem('lax_voice') || saved.ttsVoice || 'am_michael';
    const stt = document.getElementById('stt-status'), tts = document.getElementById('tts-status');
    if (stt) { stt.className = 'status-badge ok'; stt.innerHTML = '<span class="status-dot"></span> faster-whisper (sidecar)'; }
    if (tts) { tts.className = 'status-badge ok'; tts.innerHTML = `<span class="status-dot"></span> ${voice.startsWith('clone:') ? 'XTTS (cloned)' : 'Kokoro'} (${esc(voice)})`; }
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
    { value: 'gpt-5.5', label: 'GPT-5.5 (1M ctx, $5/$30)' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini (default, faster)' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4-mini' },
  ],
  anthropic: [
    { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (frontier, 1M context)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (default, faster)' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest)' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { value: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
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
  const maxIter = parseInt(document.getElementById('cfg-maxiter')?.value || '25', 10);
  const embProvider = document.getElementById('cfg-emb-provider')?.value || 'ollama';
  const embModel = document.getElementById('cfg-emb-model')?.value || '';
  const rerankModel = document.getElementById('cfg-rerank-model')?.value || '';
  const settingsPayload = { provider: s.provider, model: s.model, temperature: s.temperature, maxIterations: maxIter, embeddingProvider: embProvider === 'none' ? undefined : embProvider, embeddingModel: embModel || undefined, rerankModel: rerankModel || undefined };
  if (s.port) settingsPayload.port = s.port;
  const customUrl = document.getElementById('cfg-custom-url');
  if (customUrl && customUrl.value) settingsPayload.customBaseUrl = customUrl.value;
  await apiPost('/api/settings', settingsPayload);
  // If port changed, tell user to restart the app
  if (s.port && String(s.port) !== String(currentPort)) {
    alert('Port changed to ' + s.port + '. Please quit and relaunch Local Agent X for this to take effect.');
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
    // Embedding settings
    set('cfg-emb-provider', s.embeddingProvider || 'ollama');
    set('cfg-emb-model', s.embeddingModel || '');
    set('cfg-rerank-model', s.rerankModel || '');
    onEmbProviderChange(s.embeddingProvider || 'ollama');
    loadRerankModels(s.rerankModel);
    // Show/hide XTTS sections based on engine
    if (s.ttsEngine) onTtsEngineChange(s.ttsEngine);
    // Show local model dropdown if provider is local
    if (s.provider) onProviderChange(s.provider);
  } catch {}
  checkSyncStatus();
}

async function onEmbProviderChange(provider) {
  const hint = document.getElementById('cfg-emb-hint');
  const modelInput = document.getElementById('cfg-emb-model');
  const modelSelect = document.getElementById('cfg-emb-model-select');

  const hints = {
    ollama: 'Select an Ollama model. Run "ollama pull nomic-embed-text" to add embedding models.',
    openai: 'Recommended: text-embedding-3-small ($0.02/M tokens). Needs OPENAI_API_KEY in secrets.',
    gemini: 'Recommended: text-embedding-004. Needs GEMINI_API_KEY in secrets.',
    local: 'Built-in TF-IDF embeddings. No external server needed but lower quality.',
    none: 'Keyword search only. No semantic matching.',
  };
  if (hint) hint.textContent = hints[provider] || '';

  if (provider === 'ollama' && modelSelect) {
    // Show dropdown, hide text input, load Ollama models
    modelSelect.style.display = '';
    if (modelInput) modelInput.style.display = 'none';
    modelSelect.innerHTML = '<option value="">Loading...</option>';
    try {
      const data = await apiJson('/api/models/local');
      const models = (data.models || []).map(function(m) { return m.name; });
      if (models.length === 0) {
        modelSelect.innerHTML = '<option value="">No models found — run ollama pull nomic-embed-text</option>';
        return;
      }
      // Embedding-friendly models get sorted to top
      var embModels = ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'snowflake-arctic-embed', 'bge-large', 'bge-base'];
      var sorted = models.slice().sort(function(a, b) {
        var aEmb = embModels.some(function(e) { return a.includes(e); }) ? 0 : 1;
        var bEmb = embModels.some(function(e) { return b.includes(e); }) ? 0 : 1;
        return aEmb - bEmb || a.localeCompare(b);
      });
      modelSelect.innerHTML = sorted.map(function(m) {
        var isEmb = embModels.some(function(e) { return m.includes(e); });
        var label = isEmb ? m + ' (embedding)' : m;
        return '<option value="' + esc(m) + '">' + esc(label) + '</option>';
      }).join('');
      // Try to select saved or default
      var saved = modelInput ? modelInput.value : '';
      if (saved && sorted.includes(saved)) modelSelect.value = saved;
      else if (sorted.find(function(m) { return m.includes('nomic-embed'); })) modelSelect.value = sorted.find(function(m) { return m.includes('nomic-embed'); });
      // Sync hidden input
      if (modelInput) modelInput.value = modelSelect.value;
      modelSelect.onchange = function() { if (modelInput) modelInput.value = modelSelect.value; };
    } catch {
      modelSelect.innerHTML = '<option value="">Ollama not running</option>';
    }
  } else if (modelSelect) {
    // Non-Ollama: show text input, hide dropdown
    modelSelect.style.display = 'none';
    if (modelInput) modelInput.style.display = '';
    var defaults = { openai: 'text-embedding-3-small', gemini: 'text-embedding-004', local: '', none: '' };
    if (modelInput) modelInput.value = defaults[provider] || '';
  }
}
window.onEmbProviderChange = onEmbProviderChange;

async function loadRerankModels(saved) {
  const modelSelect = document.getElementById('cfg-rerank-model-select');
  const modelInput = document.getElementById('cfg-rerank-model');
  if (!modelSelect || !modelInput) return;

  try {
    const data = await apiJson('/api/models/local');
    const models = (data.models || []).map(function(m) { return m.name; });
    if (models.length === 0) {
      modelSelect.style.display = 'none';
      modelInput.style.display = '';
      return;
    }
    // Show dropdown, hide text input
    modelSelect.style.display = '';
    modelInput.style.display = 'none';
    // Exclude embedding-only models, sort reasoning models first
    var reasoningModels = ['qwen2', 'llama3', 'mistral', 'phi', 'gemma', 'deepseek', 'codellama'];
    var sorted = models.slice().sort(function(a, b) {
      if (a.includes('embed') && !b.includes('embed')) return 1;
      if (!a.includes('embed') && b.includes('embed')) return -1;
      var aR = reasoningModels.some(function(r) { return a.includes(r); }) ? 0 : 1;
      var bR = reasoningModels.some(function(r) { return b.includes(r); }) ? 0 : 1;
      return aR - bR || a.localeCompare(b);
    }).filter(function(m) { return !m.includes('embed'); });
    modelSelect.innerHTML = '<option value="">(disabled — no reranking)</option>' +
      sorted.map(function(m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('');
    if (saved && sorted.includes(saved)) modelSelect.value = saved;
    if (modelInput) modelInput.value = modelSelect.value;
    modelSelect.onchange = function() { if (modelInput) modelInput.value = modelSelect.value; };
  } catch {
    modelSelect.style.display = 'none';
    modelInput.style.display = '';
  }
}

// ── Conversation Ingest ──

async function handleIngestFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const countEl = document.getElementById('ingest-file-count');
  const progressEl = document.getElementById('ingest-progress');
  const fillEl = document.getElementById('ingest-progress-fill');
  const labelEl = document.getElementById('ingest-progress-label');
  const resultEl = document.getElementById('ingest-result');

  if (countEl) countEl.textContent = fileList.length + ' file' + (fileList.length > 1 ? 's' : '') + ' selected';
  if (progressEl) progressEl.style.display = '';
  if (fillEl) fillEl.style.width = '0%';
  if (labelEl) labelEl.textContent = 'Uploading...';
  if (resultEl) resultEl.style.display = 'none';

  const form = new FormData();
  for (const file of fileList) {
    form.append('file', file);
  }

  try {
    const res = await fetch(API + '/api/memory/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + AUTH_TOKEN },
      body: form,
    });
    const data = await res.json();

    if (fillEl) fillEl.style.width = '100%';
    if (labelEl) labelEl.textContent = '100% — Complete';

    if (resultEl) {
      const fmtList = data.formats ? Object.entries(data.formats).map(function(e) { return e[0] + ': ' + e[1]; }).join(', ') : 'none';
      resultEl.innerHTML =
        '<div style="color:var(--accent);margin-bottom:8px">Ingest Complete</div>' +
        '<div>Conversations processed: <strong>' + (data.processed || 0) + '</strong></div>' +
        '<div>Skipped (already imported): <strong>' + (data.skipped || 0) + '</strong></div>' +
        '<div>Chunks created: <strong>' + (data.chunksCreated || 0) + '</strong></div>' +
        '<div>Errors: <strong>' + (data.errors || 0) + '</strong></div>' +
        '<div>Formats detected: ' + fmtList + '</div>';
      resultEl.style.display = '';
    }
  } catch (e) {
    if (fillEl) fillEl.style.width = '100%';
    if (fillEl) fillEl.style.background = 'var(--danger)';
    if (labelEl) labelEl.textContent = 'Failed';
    if (resultEl) {
      resultEl.innerHTML = '<div style="color:var(--danger)">Ingest failed: ' + (e.message || 'Unknown error') + '</div>';
      resultEl.style.display = '';
    }
  }
}
window.handleIngestFiles = handleIngestFiles;

// ── TTS engine selection + cloned-voice picker ──
//
// Replaces the legacy XTTS Record/Upload UI (dead — :7862 standalone server
// was removed). Voice cloning now lives in the chat-page voice picker
// (+ Add zero-shot, + Train new voice). Settings just lets the user pick
// which engine + which clone they want for chat replies.

// Toggle the right sub-picker based on the selected engine. Built-in engines
// (kokoro/piper) show the Kokoro voice list; cloning engines show the clone
// picker populated from window._chatterboxVoices / _sovitsVoices (refreshed
// by refreshTtsClonePicker below). Browser/none hide both — nothing to pick.
function onTtsEngineChange(engine) {
  const builtin = document.getElementById('tts-voice-field');
  const clone = document.getElementById('tts-clone-field');
  const isClone = engine === 'chatterbox' || engine === 'sovits';
  const isBuiltin = engine === 'kokoro' || engine === 'piper';
  if (builtin) builtin.style.display = isBuiltin ? '' : 'none';
  if (clone) clone.style.display = isClone ? '' : 'none';
  if (isClone) refreshTtsClonePicker(engine);
}

// Populate the clone <select> from the live arrays already maintained by
// chat.js:refreshClonedVoices (which polls /api/voices/tier on chat init).
// Settings page also calls that function on load — see initVoiceSettings.
function refreshTtsClonePicker(engine) {
  const sel = document.getElementById('cfg-tts-clone');
  if (!sel) return;
  const list = engine === 'chatterbox'
    ? (window._chatterboxVoices || [])
    : (window._sovitsVoices || []);
  const prefix = engine === 'chatterbox' ? 'cb:' : 'sv:';
  sel.innerHTML = '<option value="">-- pick a clone --</option>' +
    list.map(c => {
      const star = c.fine_tuned ? ' ★' : '';
      const v = prefix + c.id;
      return `<option value="${v}">${(c.name || c.id).replace(/[<>"']/g, '')}${star}</option>`;
    }).join('');
  // Restore previous selection if it matches the current engine
  try {
    const saved = localStorage.getItem('lax_voice') || '';
    if (saved.startsWith(prefix)) sel.value = saved;
  } catch {}
}

// Fetch /api/voices/tier on settings load so we know which sidecars are
// reachable, then enable the matching options in the engine dropdown.
async function initVoiceSettings() {
  try {
    const r = await (typeof apiFetch === 'function' ? apiFetch('/api/voices/tier') : fetch('/api/voices/tier'));
    if (!r.ok) return;
    const tier = await r.json();
    const cbReady = !!(tier.chatterbox && tier.chatterbox.ready);
    const svReady = !!(tier.sovits && tier.sovits.ready);
    window._studioTierReady = cbReady;
    window._sovitsTierReady = svReady;
    // Pull the actual clone lists if their sidecars are up
    if (cbReady) {
      try {
        const cr = await apiFetch('/api/voices/chatterbox');
        if (cr.ok) {
          const d = await cr.json();
          window._chatterboxVoices = Array.isArray(d?.clones) ? d.clones : [];
        }
      } catch {}
    }
    if (svReady) {
      try {
        const sr = await apiFetch('/api/voices/sovits');
        if (sr.ok) {
          const d = await sr.json();
          window._sovitsVoices = Array.isArray(d?.clones) ? d.clones : [];
        }
      } catch {}
    }
    // Enable the clone-engine options if either sidecar is up
    const group = document.getElementById('cfg-tts-clone-group');
    const cbOpt = document.getElementById('cfg-tts-engine-cb');
    const svOpt = document.getElementById('cfg-tts-engine-sv');
    if (group && (cbReady || svReady)) group.style.display = '';
    if (cbOpt) cbOpt.disabled = !cbReady;
    if (svOpt) svOpt.disabled = !svReady;
    // Re-trigger engine-change to refresh the sub-picker if a cloning engine
    // was already saved from a prior session.
    const engSel = document.getElementById('cfg-tts-engine');
    if (engSel) onTtsEngineChange(engSel.value);
  } catch { /* silent — Settings page works fine without sidecars */ }
}

// Auto-init on page load. Settings.html may load this script before chat.js,
// so we guard against the DOM not being ready yet.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { initVoiceSettings(); initVoiceVisualsToggle(); });
} else {
  initVoiceSettings();
  initVoiceVisualsToggle();
}

// Persist the visualizer toggle to /api/settings. Server stores it on the
// live LAXConfig (voice_visuals_enabled) and the next voice turn picks it
// up via the existing config hot-reload path. Default ON.
async function initVoiceVisualsToggle() {
  const el = document.getElementById('cfg-voice-visuals');
  if (!el) return;
  try {
    const r = await (typeof apiFetch === 'function' ? apiFetch('/api/settings') : fetch('/api/settings'));
    if (r.ok) {
      const s = await r.json();
      // Treat undefined as ON (default)
      el.checked = s.voice_visuals_enabled !== false;
    }
  } catch { /* leave default checked state */ }
}
function onVoiceVisualsToggle(checked) {
  const tok = (new URLSearchParams(location.search).get('token') || localStorage.getItem('sax_token') || '');
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ voice_visuals_enabled: !!checked }),
  }).catch(() => {});
}

// ── Removed: ~275 lines of dead XTTS Record/Upload UI ──
// The standalone XTTS server at :7862 is long gone. Voice cloning is owned
// by the chat-page voice picker now (+ Add a quick zero-shot voice…,
// + Train a new voice…). Functions purged: loadXttsVoices, webmToWav,
// startVisualizer, stopVisualizer, toggleVoiceRecording, uploadVoiceSample,
// sendVoiceSample, startXttsServer, previewVoice, deleteVoice.

// (No backwards-compat shim needed — the inline onclicks were in the same
// HTML block we just deleted. If this throws on someone's stale tab, a
// hard refresh fixes it.)

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

async function setApprovalMode(mode) {
  // Save via the generic /api/settings endpoint (merged into settings.json).
  // approval-manager.ts reads settings.json.toolApproval on every tool call.
  try {
    await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolApproval: mode })
    });
  } catch (e) { console.warn('[approval-mode] save failed', e); }
}

// Load saved approval mode on settings page open
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await apiFetch('/api/settings');
    if (!res.ok) return;
    const s = await res.json();
    if (s?.toolApproval) {
      const el = document.getElementById('cfg-approval-mode');
      if (el) el.value = s.toolApproval;
    }
  } catch {}
});

// Self-modify mode removed — platform files always protected

// ── Settings Search ──

function searchSettings(query) {
  const q = query.toLowerCase().trim();
  const cards = document.querySelectorAll('.settings-content .section-card');
  const tabs = document.querySelectorAll('.tab-pane');
  if (!q) {
    // Show all, restore tab state
    cards.forEach(c => c.style.display = '');
    tabs.forEach(t => t.style.display = '');
    return;
  }
  // Show all tabs, filter cards by text content
  tabs.forEach(t => t.style.display = '');
  cards.forEach(c => {
    const text = c.textContent.toLowerCase();
    c.style.display = text.includes(q) ? '' : 'none';
  });
}

// Simple mode removed — all features visible to all users

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
          <h2 class="onboarding-title">Welcome to Local Agent X</h2>
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
            <button class="onboarding-option" onclick="selectOnboardProvider('anthropic')"><strong>Anthropic Claude</strong><br><span style="color:var(--muted);font-size:.72rem">Subscription auth</span></button>
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
    desc.textContent = 'Sign in with your Anthropic account to use Claude models. Anthropic may require Extra Usage for external-tool traffic.';
    container.innerHTML = `
      <button class="action-btn primary" onclick="onboardOAuth('anthropic')" style="padding:10px 32px;font-size:1rem">Sign In with Claude</button>
      <span style="color:var(--muted);font-size:.75rem">Subscription auth; Anthropic may require Extra Usage</span>
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
    const defaults = { codex: 'gpt-5.3-codex', anthropic: 'claude-sonnet-4-6', xai: 'grok-3-mini', gemini: 'gemini-2.0-flash', local: '', custom: '' };
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

// ── Voice Engines (setup, install, start/stop) ──

async function refreshVoiceSetup() {
  const statusEl = document.getElementById('voice-setup-status');
  const tiersEl = document.getElementById('voice-setup-tiers');
  if (!tiersEl) return;
  if (statusEl) statusEl.textContent = 'Probing tiers…';
  try {
    const d = await apiJson('/api/voices/setup/status');
    if (statusEl) statusEl.textContent = `Platform: ${d.platform}. Each tier installs to its own venv (~/.lax/) and runs on its own port.`;
    tiersEl.innerHTML = (d.tiers || []).map(renderVoiceTierCard).join('');
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--err,#c33)'; statusEl.textContent = 'Failed to load voice setup: ' + (e.message || e); }
  }
}

function renderVoiceTierCard(t) {
  const dot = (color) => `<span class="status-dot" style="background:${color};display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>`;
  let badge;
  if (t.healthy) badge = `<span style="color:var(--accent)">${dot('var(--accent)')}Running &amp; healthy${t.pid ? ` (pid ${t.pid})` : ''}</span>`;
  else if (t.running) badge = `<span style="color:#dba917">${dot('#dba917')}Running, not ready yet</span>`;
  else if (t.installed) badge = `<span style="color:var(--muted)">${dot('var(--muted)')}Installed, not running</span>`;
  else badge = `<span style="color:var(--err,#c33)">${dot('var(--err,#c33)')}Not installed</span>`;

  const buttons = [];
  if (!t.installed && t.hasInstaller) buttons.push(`<button class="action-btn primary" onclick="installVoiceTier('${t.id}', this)">Install (${esc(t.diskFootprint || 'sized')})</button>`);
  if (!t.installed && !t.hasInstaller) buttons.push(`<button class="action-btn" disabled title="No one-click installer for this tier">Install via training pipeline</button>`);
  if (t.installed && !t.healthy) buttons.push(`<button class="action-btn primary" onclick="startVoiceTier('${t.id}', this)">Start sidecar</button>`);
  if (t.running || t.healthy) buttons.push(`<button class="action-btn danger" onclick="stopVoiceTier('${t.id}', this)">Stop</button>`);

  return `
    <div class="section-card" style="margin-bottom:10px;padding:10px 12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-weight:600">${esc(t.label)} <span style="font-family:var(--mono);font-size:.7rem;color:var(--muted);font-weight:normal">:${t.port}</span></div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:2px">${esc(t.description)}</div>
        </div>
        <div style="text-align:right;font-size:.72rem">${badge}</div>
      </div>
      <div id="voice-tier-output-${t.id}" style="display:none;margin-top:8px;font-family:var(--mono);font-size:.65rem;color:var(--muted);background:var(--bg);padding:6px 8px;border-radius:4px;max-height:140px;overflow:auto;white-space:pre-wrap"></div>
      <div class="btn-row" style="margin-top:8px">${buttons.join('')}</div>
    </div>
  `;
}

async function installVoiceTier(id, btn) {
  const outEl = document.getElementById('voice-tier-output-' + id);
  if (btn) { btn.disabled = true; btn.textContent = 'Installing… (this may take 5–15 minutes)'; }
  if (outEl) { outEl.style.display = ''; outEl.textContent = 'Running installer…'; }
  try {
    const d = await apiPost('/api/voices/setup/install', { tier: id });
    if (outEl) outEl.textContent = (d.output || '').trim() || (d.ok ? 'Installed.' : 'Failed.');
    if (!d.ok) throw new Error('Installer exited with code ' + d.exitCode);
  } catch (e) {
    if (outEl) outEl.textContent = (outEl.textContent ? outEl.textContent + '\n' : '') + 'Error: ' + (e.message || e);
  } finally {
    refreshVoiceSetup();
  }
}

async function startVoiceTier(id, btn) {
  const outEl = document.getElementById('voice-tier-output-' + id);
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  if (outEl) { outEl.style.display = ''; outEl.textContent = 'Spawning sidecar, waiting for /healthz (up to 60s)…'; }
  try {
    const d = await apiPost('/api/voices/setup/start', { tier: id });
    if (outEl) outEl.textContent = d.already ? 'Already running.' : ('Started, pid ' + (d.pid || '?') + '. Health: ' + JSON.stringify(d.healthPayload || {}));
  } catch (e) {
    if (outEl) outEl.textContent = (outEl.textContent ? outEl.textContent + '\n' : '') + 'Error: ' + (e.message || e);
  } finally {
    refreshVoiceSetup();
  }
}

async function stopVoiceTier(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; }
  try { await apiPost('/api/voices/setup/stop', { tier: id }); } catch {}
  refreshVoiceSetup();
}

