// ── Settings Panel ──

async function settingsCheckUpdate() {
  const status = document.getElementById('settings-update-status');
  if (!status) return;
  status.style.color = 'var(--muted)';
  status.textContent = 'Checking...';
  try {
    const res = await apiFetch('/api/updates/check');
    const data = await res.json();
    // Surface check failures explicitly — without this, a 404/offline/auth
    // failure rendered as a confident "up to date" message and the user
    // would never know an update was actually waiting.
    if (data.error) {
      status.style.color = 'var(--error, red)';
      status.textContent = 'Could not check for updates: ' + data.error;
      return;
    }
    if (data.updateAvailable) {
      status.style.color = 'var(--accent)';
      const summary = `Update available: v${esc(data.remoteVersion)}${data.remoteCommit ? ' (' + esc(data.remoteCommit) + ')' : ''}${data.releaseNotes ? ' — ' + esc(data.releaseNotes) : ''}`;
      status.innerHTML = `${summary} <button onclick="settingsApplyUpdate()" style="margin-left:10px;padding:4px 12px;background:var(--accent);color:var(--bg);border:none;border-radius:4px;cursor:pointer;font-weight:600">Update Now</button> <a href="https://github.com/Local-Agent-X/Local-Agent-X" target="_blank" style="color:var(--muted);margin-left:8px;font-size:.8em">View on GitHub</a>`;
    } else {
      status.style.color = 'var(--accent)';
      status.textContent = 'You are up to date! (v' + (data.localVersion || '0.1.0') + ')';
    }
  } catch (e) {
    status.style.color = 'var(--error, red)';
    status.textContent = 'Could not check for updates.';
  }
}

// Pull the latest source from GitHub, then prompt a full quit + relaunch.
// We deliberately do NOT just restart the server child here: the desktop
// wrapper's reconcile step (root/desktop `npm install` + desktop `npm run
// build`) only runs at Electron boot. A server-only restart would silently
// leave the user on stale deps when a pull bumps package-lock.json, or on
// a stale desktop wrapper when desktop/src changes. A full relaunch makes
// reconcile catch everything; server code under src/ runs via tsx and
// picks up automatically.
async function settingsApplyUpdate() {
  const status = document.getElementById('settings-update-status');
  if (!status) return;
  if (!confirm('Pull the latest version from GitHub? You will be asked to relaunch the app afterward to finish installing.')) return;
  status.style.color = 'var(--muted)';
  status.innerHTML = 'Pulling latest from GitHub...';
  try {
    const res = await apiFetch('/api/updates/apply', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      status.style.color = 'var(--error, red)';
      status.textContent = data.error || 'Update failed. See server log for details.';
      if (Array.isArray(data.dirty) && data.dirty.length) {
        status.textContent += ' (Local changes: ' + data.dirty.slice(0, 3).join(', ') + (data.dirty.length > 3 ? '…' : '') + ')';
      }
      return;
    }
    status.style.color = 'var(--accent)';
    const pulled = `Pulled <code>${esc(data.fromCommit)}</code> → <code>${esc(data.toCommit)}</code>.`;
    if (window.desktop && window.desktop.relaunchApp) {
      status.innerHTML = `${pulled} Relaunch to finish installing (runs <code>npm install</code> + build if needed). <button onclick="window.desktop.relaunchApp()" style="margin-left:10px;padding:4px 12px;background:var(--accent);color:var(--bg);border:none;border-radius:4px;cursor:pointer;font-weight:600">Quit &amp; Relaunch</button>`;
    } else {
      status.innerHTML = `${pulled} <strong>Quit and relaunch the app to finish installing</strong> (it will run <code>npm install</code> and rebuild on next boot).`;
    }
  } catch (e) {
    status.style.color = 'var(--error, red)';
    status.textContent = 'Update failed: ' + (e && e.message ? e.message : String(e));
  }
}

function init_settings() {
  loadSettings();
  loadSyncConfig();
  checkSettingsAuth();
  checkAnthropicAuth();
  checkXaiAuth();
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
  if (window.MemoryBrain) { if (id === 'memory') window.MemoryBrain.ensure(); else window.MemoryBrain.pause(); }
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
    // Codex CLI status — three states, not two. The CLI binary being
    // present is separate from the CLI being signed in (~/.codex/auth.json).
    // Previously we conflated them: green "installed" badge even when the
    // CLI had no auth, so build_app would 401 in mysterious silence. The
    // user called this "the UI lying" — fixed by surfacing the
    // installed-but-not-signed-in state explicitly with a fix instruction.
    if (cliEl) {
      if (!d.cliInstalled) {
        cliEl.className = 'status-badge err';
        cliEl.innerHTML = '<span class="status-dot"></span> Codex CLI not found — install it for reliable app building via Codex (otherwise falls back to Claude CLI)';
        if (cliBtn) cliBtn.style.display = '';
      } else if (d.cliAuthenticated === false) {
        cliEl.className = 'status-badge warn';
        cliEl.innerHTML = '<span class="status-dot"></span> Codex CLI installed but NOT signed in — run <code>codex login</code> in Terminal to enable build_app. The LAX "Sign in with OpenAI" button only authenticates LAX itself; the CLI has its own credential store at ~/.codex/auth.json.';
        if (cliBtn) cliBtn.style.display = 'none';
      } else {
        cliEl.className = 'status-badge ok';
        cliEl.innerHTML = '<span class="status-dot"></span> Codex CLI installed and signed in — app builder will use subprocess for reliable large file writes';
        if (cliBtn) cliBtn.style.display = 'none';
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

// Codex CLI login flow — mirror of the Anthropic Sign-in-via-Claude-CLI
// flow in settings-anthropic.js. Spawns `codex login` server-side,
// captures the OAuth URL, opens it in a new tab, then polls
// /api/auth/status until `cliAuthenticated` flips true. Acts as the
// fallback path; the primary "Sign in with OpenAI" button should
// already bridge both stores so users don't typically need this.
let _codexCliLoginPoll = null;
async function doCodexCliLogin() {
  const btn = document.getElementById('btn-codex-cli-login');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Starting...'; }
  try {
    const d = await apiPost('/api/auth/openai/cli-login', {});
    if (!d.authUrl) throw new Error(d.error || 'No auth URL returned');
    window.open(d.authUrl, '_blank');
    if (btn) btn.textContent = '⏳ Complete sign-in in browser tab...';
    if (_codexCliLoginPoll) clearInterval(_codexCliLoginPoll);
    let attempts = 0;
    _codexCliLoginPoll = setInterval(async () => {
      attempts++;
      try {
        const r = await apiFetch('/api/auth/status');
        const s = await r.json();
        if (s.cliAuthenticated) {
          clearInterval(_codexCliLoginPoll); _codexCliLoginPoll = null;
          if (btn) { btn.textContent = '✓ Signed in'; btn.disabled = true; }
          checkSettingsAuth();
        }
      } catch {}
      if (attempts > 150) { // ~5 min @ 2s
        clearInterval(_codexCliLoginPoll); _codexCliLoginPoll = null;
        if (btn) { btn.textContent = '⏱ Timed out — try again'; btn.disabled = false; }
        try { await apiPost('/api/auth/openai/cli-login-cancel', {}); } catch {}
      }
    }, 2000);
  } catch (e) {
    if (btn) { btn.textContent = '✗ Failed — retry'; btn.disabled = false; }
    console.error('Codex CLI login failed:', e);
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

