// ── Settings: Anthropic Auth ──
//
// All Anthropic / Claude CLI auth flows: status check, OAuth login,
// CLI install, token capture, disconnect. Lives separately from the
// generic provider/key UI because Anthropic is OAuth-only (no plain
// API key path here).

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
        const v = d.cliVersion ? ` (v${esc(d.cliVersion)})` : '';
        cliEl.innerHTML = '<span class="status-dot"></span> Claude CLI installed' + v + ' — required for all Anthropic auth paths';
        if (cliBtn) cliBtn.style.display = 'none';
      } else {
        cliEl.className = 'status-badge err';
        cliEl.innerHTML = '<span class="status-dot"></span> Claude CLI not found — install it (required for all Anthropic auth)';
        if (cliBtn) cliBtn.style.display = '';
      }
    }
    // Hide the Update CLI button when CLI isn't installed; the Install button covers that path.
    const updBtn = document.getElementById('btn-update-claude-cli');
    if (updBtn) updBtn.style.display = d.cliInstalled ? '' : 'none';
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

async function updateClaudeCli() {
  const btn = document.getElementById('btn-update-claude-cli');
  const status = document.getElementById('claude-cli-update-status');
  if (!btn) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Updating...';
  if (status) { status.style.display = ''; status.style.color = ''; status.innerHTML = 'Running <code>npm install -g @anthropic-ai/claude-code@latest</code>... (up to 3 min)'; }
  try {
    const d = await apiPost('/api/auth/anthropic/update-cli', {});
    if (!d.ok) throw new Error(d.error || 'Update failed');
    if (status) {
      if (d.changed) {
        status.innerHTML = '<span style="color:var(--accent)">✓ Updated ' + esc(d.before || 'unknown') + ' → ' + esc(d.after) + '. Restart any active Claude turn to pick up the new binary.</span>';
      } else {
        status.innerHTML = '<span style="color:var(--muted)">Already on the latest release (' + esc(d.after) + ').</span>';
      }
    }
    await checkAnthropicAuth();
  } catch (e) {
    if (status) { status.style.color = 'var(--err,#c33)'; status.innerHTML = esc(e.message || 'Update failed'); }
  } finally {
    btn.disabled = false;
    btn.textContent = prev || 'Update CLI';
  }
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

