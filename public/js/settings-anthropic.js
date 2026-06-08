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
    const discBtn = document.getElementById('btn-anthropic-disconnect');
    const cliLoginBtn = document.getElementById('btn-anthropic-cli-login');
    const cliEl = document.getElementById('claude-cli-status');
    const cliBtn = document.getElementById('btn-install-claude-cli');
    if (!el) return;
    // CLI session is always "valid" — its auth is managed by the CLI, not us
    const usingCliSession = d.method === 'cli-session';
    const hasValidAuth = d.authenticated && (usingCliSession || !d.expired);
    const optionsBlock = document.getElementById('anthropic-options');
    // Always show the options block — even when connected, the user may want
    // to switch auth methods (CLI login ↔ setup-token). Connected buttons
    // render as "Already Connected" (disabled) per the OpenAI pattern.
    if (optionsBlock) optionsBlock.style.display = '';
    if (hasValidAuth) {
      el.className = 'status-badge ok';
      const label =
        d.method === 'token' ? 'Connected — Setup-token (routes through CLI subprocess)' :
        usingCliSession ? 'Connected — Claude CLI login (auto-detected from ~/.claude/.credentials.json)' :
        'Connected — Stale direct OAuth tokens (third-party use blocked by Anthropic TOS — disconnect and use CLI login)';
      el.innerHTML = '<span class="status-dot"></span> ' + label;
      // CLI-login button: when CLI session is the active auth, mark "Already Connected".
      if (cliLoginBtn) {
        cliLoginBtn.textContent = usingCliSession ? 'Already Connected' : 'Sign in via Claude CLI';
        cliLoginBtn.disabled = usingCliSession;
      }
      // Disconnect always visible while connected. The handler routes to the
      // correct logout endpoint (CLI vs our tokens) based on auth method.
      if (discBtn) discBtn.style.display = '';
    } else {
      el.className = 'status-badge err';
      el.innerHTML = '<span class="status-dot"></span> Not connected';
      if (cliLoginBtn) { cliLoginBtn.textContent = 'Sign in via Claude CLI'; cliLoginBtn.disabled = false; }
      if (discBtn) discBtn.style.display = 'none';
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

// Paste-the-code flow: open the authorize URL, the user copies the code the
// page shows after authorizing and pastes it back here. We exchange it and
// write the CLI's credential store server-side. No polling, no spawned CLI.
async function doClaudeCliLogin() {
  const btn = document.getElementById('btn-anthropic-cli-login');
  const cancelBtn = document.getElementById('btn-anthropic-cli-login-cancel');
  const status = document.getElementById('anthropic-cli-login-status');
  if (!btn || !status) return;
  btn.disabled = true; btn.textContent = 'Starting...';
  status.innerHTML = 'Opening sign-in…';
  try {
    const d = await apiPost('/api/auth/anthropic/cli-login', {});
    if (!d.authUrl) throw new Error(d.error || 'No URL returned');
    // Open the authorize page for the user. They authorize, the page shows a
    // code; they paste it into the box below.
    window.open(d.authUrl, '_blank', 'noopener');
    status.innerHTML =
      '<div style="margin-bottom:6px"><strong>Step 1.</strong> Approve in the browser tab that just opened ' +
      '(or <a href="' + esc(d.authUrl) + '" target="_blank" rel="noopener">open it again</a>).</div>' +
      '<div style="margin-bottom:6px"><strong>Step 2.</strong> Copy the code the page shows and paste it here:</div>' +
      '<div style="display:flex;gap:8px;max-width:520px">' +
      '  <input id="anthropic-cli-code" class="field-input" type="text" placeholder="paste code from the authorization page" autocomplete="off" style="flex:1" />' +
      '  <button id="btn-anthropic-cli-submit" class="action-btn primary" onclick="submitClaudeCliCode()">Finish sign-in</button>' +
      '</div>' +
      '<div id="anthropic-cli-code-msg" class="field-hint" style="margin-top:6px"></div>';
    btn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = '';
    const input = document.getElementById('anthropic-cli-code');
    if (input) {
      input.focus();
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submitClaudeCliCode(); });
    }
  } catch (e) {
    status.innerHTML = '<span style="color:var(--err,#c33)">' + esc(e.message || 'Login failed') + '</span>';
    btn.disabled = false; btn.textContent = 'Sign in via Claude CLI';
  }
}

async function submitClaudeCliCode() {
  const input = document.getElementById('anthropic-cli-code');
  const submitBtn = document.getElementById('btn-anthropic-cli-submit');
  const msg = document.getElementById('anthropic-cli-code-msg');
  const status = document.getElementById('anthropic-cli-login-status');
  const btn = document.getElementById('btn-anthropic-cli-login');
  const cancelBtn = document.getElementById('btn-anthropic-cli-login-cancel');
  const code = String(input && input.value || '').trim();
  if (!code) { if (msg) { msg.style.color = 'var(--err,#c33)'; msg.textContent = 'Paste the code first.'; } return; }
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Finishing…'; }
  if (msg) { msg.style.color = ''; msg.textContent = 'Exchanging code…'; }
  try {
    await apiPost('/api/auth/anthropic/cli-login-submit', { code });
    if (status) status.innerHTML = '<span style="color:var(--accent)">✓ Signed in. Chat &amp; builds route through the Claude CLI subprocess.</span>';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Re-sign in'; }
    checkAnthropicAuth();
  } catch (e) {
    if (msg) { msg.style.color = 'var(--err,#c33)'; msg.textContent = e.message || 'Code exchange failed. Try signing in again.'; }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Finish sign-in'; }
  }
}

async function cancelClaudeCliLogin() {
  const btn = document.getElementById('btn-anthropic-cli-login');
  const cancelBtn = document.getElementById('btn-anthropic-cli-login-cancel');
  const status = document.getElementById('anthropic-cli-login-status');
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

async function doAnthropicDisconnect() {
  if (!confirm('Disconnect from Anthropic? Removes saved tokens AND signs out the Claude CLI session.')) return;
  // Both endpoints are safe to call regardless of which auth path is active:
  // /logout deletes our stored OAuth/setup-token (no-op if none saved);
  // /cli-logout runs `claude auth logout` (no-op if CLI isn't signed in).
  try { await apiFetch('/api/auth/anthropic/logout', { method: 'POST' }); } catch {}
  try { await apiFetch('/api/auth/anthropic/cli-logout', { method: 'POST' }); } catch {}
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
    const saved = JSON.parse(localStorage.getItem('lax_settings') || '{}');
    const voice = localStorage.getItem('lax_voice') || saved.ttsVoice || 'am_michael';
    const stt = document.getElementById('stt-status'), tts = document.getElementById('tts-status');
    if (stt) { stt.className = 'status-badge ok'; stt.innerHTML = '<span class="status-dot"></span> faster-whisper (sidecar)'; }
    if (tts) { tts.className = 'status-badge ok'; tts.innerHTML = `<span class="status-dot"></span> ${voice.startsWith('clone:') ? 'XTTS (cloned)' : 'Kokoro'} (${esc(voice)})`; }
  } catch {}
}

