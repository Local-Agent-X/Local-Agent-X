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
      status.innerHTML = `Update available: v${esc(data.remoteVersion)}${data.remoteCommit ? ' (' + esc(data.remoteCommit) + ')' : ''}${data.releaseNotes ? ' — ' + esc(data.releaseNotes) : ''} <a href="https://github.com/petermanrique101-sys/Local-Agent-X" target="_blank" style="color:var(--accent);margin-left:8px">View on GitHub</a>`;
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
    // Poll auth status until OAuth completes in the browser tab. When
    // detected, refresh BOTH the settings UI (checkSettingsAuth) AND the
    // global sidebar indicator (checkAuth) — without the second call,
    // bottom-left stays "not connected" after OAuth lands and the user
    // has to reload the window to see the green dot. ~5min max.
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const r = await apiFetch('/api/auth/status');
        const s = await r.json();
        if (s.authenticated) {
          clearInterval(poll);
          checkSettingsAuth();
          if (typeof checkAuth === 'function') checkAuth();
          return;
        }
      } catch {}
      if (attempts > 150) clearInterval(poll); // ~5min @ 2s
    }, 2000);
  } catch (e) { console.error('Login failed:', e); }
}

async function doDisconnect() {
  if (!confirm('Disconnect from OpenAI?')) return;
  await apiFetch('/api/auth/logout', { method: 'POST' });
  checkSettingsAuth(); checkAuth();
}


// Settings split into focused modules for the 400-LOC rule:
//   settings-anthropic.js
//   settings-providers.js
//   settings-voice-tier4.js
//   settings-embedding.js
//   settings-conversation-ingest.js
//   settings-tts.js
//   settings-agent-sync.js
//   settings-file-access.js
//   settings-search.js
//   settings-integrations.js
//   settings-import-export.js
//   settings-voice-engines.js

// ── Auto-init ──
// Call init_settings when the script loads (fixes integrations not loading)
if (document.getElementById('integrations-list')) {
  init_settings();
}

// Show onboarding on first run
shouldShowOnboarding().then(show => {
  if (show) setTimeout(showOnboarding, 500);
});

