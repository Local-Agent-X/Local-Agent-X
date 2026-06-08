// ── Settings: xAI Grok OAuth ──
//
// SuperGrok / X Premium+ subscription auth. Lives next to the OpenAI and
// Anthropic auth blocks. OAuth bearer is wire-identical to XAI_API_KEY on
// api.x.ai/v1, so the existing openai-http adapter consumes either.

let _xaiWasAuthed = null;
async function checkXaiAuth() {
  try {
    const d = await apiJson('/api/auth/xai/status');
    const el = document.getElementById('xai-auth-status');
    const loginBtn = document.getElementById('btn-xai-login');
    const discBtn = document.getElementById('btn-xai-disconnect');
    if (!el) return;
    // Refresh the chat provider picker on the connect/disconnect transition
    // (this is polled, so only fire on a real change — not every tick).
    if (_xaiWasAuthed !== null && _xaiWasAuthed !== !!d.authenticated) window.refreshProviderPicker?.();
    _xaiWasAuthed = !!d.authenticated;
    if (d.authenticated) {
      el.className = 'status-badge ok';
      let label;
      if (d.method === 'oauth') label = 'Connected — SuperGrok / X Premium+ OAuth';
      else if (d.method === 'api_key') label = 'Connected — XAI_API_KEY (paste OAuth above to switch)';
      else label = 'Connected';
      el.innerHTML = '<span class="status-dot"></span> ' + label;
      if (loginBtn) {
        const oauthActive = d.method === 'oauth';
        loginBtn.textContent = oauthActive ? 'Already Connected via OAuth' : 'Sign in with xAI (SuperGrok / X Premium+)';
        loginBtn.disabled = oauthActive;
      }
      // Disconnect button shows when we have OAuth tokens to clear.
      if (discBtn) discBtn.style.display = d.hasOAuth ? '' : 'none';
    } else {
      el.className = 'status-badge err';
      el.innerHTML = '<span class="status-dot"></span> Not connected';
      if (loginBtn) { loginBtn.textContent = 'Sign in with xAI (SuperGrok / X Premium+)'; loginBtn.disabled = false; }
      if (discBtn) discBtn.style.display = 'none';
    }
    // Grok Build CLI badge — separate credential store (~/.grok/auth.json)
    // from the OAuth above; drives the self_edit surgeon. cliInstalled /
    // cliAuthenticated come from the same /api/auth/xai/status response.
    const cliEl = document.getElementById('xai-cli-status');
    const cliInstallBtn = document.getElementById('btn-install-grok-cli');
    const cliLoginBtn = document.getElementById('btn-grok-cli-login');
    if (cliEl) {
      if (!d.cliInstalled) {
        cliEl.className = 'status-badge warn';
        cliEl.innerHTML = '<span class="status-dot"></span> Grok Build CLI not installed';
        if (cliInstallBtn) cliInstallBtn.style.display = '';
        if (cliLoginBtn) cliLoginBtn.disabled = true;
      } else if (!d.cliAuthenticated) {
        cliEl.className = 'status-badge warn';
        cliEl.innerHTML = '<span class="status-dot"></span> Grok Build CLI installed but NOT signed in — click “Sign in via Grok Build CLI”.';
        if (cliInstallBtn) cliInstallBtn.style.display = 'none';
        if (cliLoginBtn) { cliLoginBtn.disabled = false; cliLoginBtn.textContent = 'Sign in via Grok Build CLI'; }
      } else {
        cliEl.className = 'status-badge ok';
        cliEl.innerHTML = '<span class="status-dot"></span> Grok Build CLI signed in (~/.grok/auth.json)';
        if (cliInstallBtn) cliInstallBtn.style.display = 'none';
        if (cliLoginBtn) { cliLoginBtn.disabled = true; cliLoginBtn.textContent = '✓ Signed in'; }
      }
    }
  } catch {}
}

// Grok Build CLI login — mirror of the Codex CLI flow (doCodexCliLogin in
// settings.js). Spawns `grok login --device-auth` server-side, captures the
// device URL, opens it, then polls /api/auth/xai/status until cliAuthenticated
// flips. This signs in the `grok` binary's own store so self_edit can use it.
let _grokCliLoginPoll = null;
async function doGrokCliLogin() {
  const btn = document.getElementById('btn-grok-cli-login');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Starting...'; }
  try {
    const d = await apiPost('/api/auth/xai/cli-login', {});
    if (!d.authUrl) throw new Error(d.error || 'No auth URL returned');
    window.open(d.authUrl, '_blank');
    if (btn) btn.textContent = '⏳ Complete sign-in in browser tab...';
    if (_grokCliLoginPoll) clearInterval(_grokCliLoginPoll);
    let attempts = 0;
    _grokCliLoginPoll = setInterval(async () => {
      attempts++;
      try {
        const s = await apiJson('/api/auth/xai/status');
        if (s.cliAuthenticated) {
          clearInterval(_grokCliLoginPoll); _grokCliLoginPoll = null;
          if (btn) { btn.textContent = '✓ Signed in'; btn.disabled = true; }
          checkXaiAuth();
        }
      } catch {}
      if (attempts > 150) { // ~5 min @ 2s
        clearInterval(_grokCliLoginPoll); _grokCliLoginPoll = null;
        if (btn) { btn.textContent = '⏱ Timed out — try again'; btn.disabled = false; }
        try { await apiPost('/api/auth/xai/cli-login-cancel', {}); } catch {}
      }
    }, 2000);
  } catch (e) {
    if (btn) { btn.textContent = '✗ Failed — retry'; btn.disabled = false; }
    console.error('Grok CLI login failed:', e);
  }
}

async function installGrokCli() {
  const btn = document.getElementById('btn-install-grok-cli');
  const cliEl = document.getElementById('xai-cli-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Installing...'; }
  try {
    const d = await apiPost('/api/auth/xai/install-cli', {});
    if (d.error) throw new Error(d.error);
    if (btn) { btn.textContent = '✓ Installed'; btn.style.display = 'none'; }
    checkXaiAuth();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Install Grok Build CLI'; }
    if (cliEl) { cliEl.className = 'status-badge err'; cliEl.innerHTML = '<span class="status-dot"></span> Install failed: ' + (e?.message || 'unknown'); }
  }
}

async function doXaiLogin() {
  const btn = document.getElementById('btn-xai-login');
  if (btn) { btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Opening browser...'; setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 4000); }
  try {
    const d = await apiPost('/api/auth/xai/login', {});
    // The server tries to launch the system browser itself, but that can
    // silently no-op (e.g. rundll32 FileProtocolHandler on some Windows
    // setups), and a fire-and-forget spawn can't confirm the browser
    // actually opened — so d.opened is only a hint. ALWAYS surface a
    // clickable recovery link regardless: a real user click on an <a> routes
    // through Electron's setWindowOpenHandler -> shell.openExternal, which is
    // reliable where programmatic window.open (dropped by Chromium for these
    // long URLs) is not.
    if (d.authUrl) {
      showXaiOpenFallback(d.authUrl, !!d.opened);
      // Best-effort programmatic open only when the server didn't claim it
      // already launched — harmless if it gets dropped.
      if (!d.opened) { try { window.open(d.authUrl, '_blank'); } catch {} }
    }
    // Poll for completion — xAI's callback flips the token file but
    // doesn't notify the UI directly.
    setTimeout(checkXaiAuth, 5000);
    setTimeout(checkXaiAuth, 15000);
    setTimeout(checkXaiAuth, 30000);
  } catch (e) {
    console.error('xAI login failed:', e);
    const fb = document.getElementById('xai-open-fallback');
    if (fb) { fb.style.display = ''; fb.textContent = 'Could not start xAI login: ' + (e?.message || 'unknown error') + '. Try again.'; }
  }
}

// Render a clickable fallback link + copy button for the xAI auth URL. Shown
// on every login attempt so the user is never stranded when the server-side
// browser launch silently fails (the bug this fixes: server reported
// opened=true while rundll32 no-op'd, suppressing the only recovery path).
function showXaiOpenFallback(authUrl, opened) {
  const fb = document.getElementById('xai-open-fallback');
  if (!fb) { if (!opened) { try { window.open(authUrl, '_blank'); } catch {} } return; }
  fb.style.display = '';
  fb.innerHTML = '';
  const note = document.createElement('div');
  note.style.color = 'var(--muted)';
  note.style.marginBottom = '6px';
  note.textContent = opened
    ? "Didn't see the sign-in page open? Click here:"
    : 'Open the xAI sign-in page:';
  const link = document.createElement('a');
  link.href = authUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Open xAI sign-in page';
  link.style.color = 'var(--accent)';
  link.style.fontWeight = '600';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'action-btn secondary';
  copyBtn.textContent = 'Copy link';
  copyBtn.style.marginLeft = '10px';
  copyBtn.style.padding = '4px 12px';
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(authUrl); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000); }
    catch { copyBtn.textContent = 'Copy failed'; }
  };
  fb.appendChild(note);
  fb.appendChild(link);
  fb.appendChild(copyBtn);
}

async function doXaiExchangeCode() {
  const input = document.getElementById('xai-manual-code');
  const status = document.getElementById('xai-manual-status');
  const code = (input?.value || '').trim();
  if (status) { status.style.color = ''; status.textContent = ''; }
  if (!code) { if (status) status.textContent = 'Paste the code from xAI first.'; return; }
  try {
    await apiPost('/api/auth/xai/exchange-code', { code });
    if (input) { input.value = ''; input.placeholder = 'connected'; }
    if (status) { status.style.color = 'var(--accent)'; status.textContent = 'Connected to xAI.'; }
    checkXaiAuth();
  } catch (e) {
    if (status) status.textContent = 'Code exchange failed. Make sure Sign In was clicked first, then try again.';
  }
}

async function doXaiDisconnect() {
  if (!confirm('Disconnect xAI OAuth? Removes saved tokens from ~/.lax/xai-auth.json. Any saved XAI_API_KEY stays in place.')) return;
  try { await apiFetch('/api/auth/xai/logout', { method: 'POST' }); } catch {}
  checkXaiAuth();
}
