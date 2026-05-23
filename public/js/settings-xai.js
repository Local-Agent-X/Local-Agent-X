// ── Settings: xAI Grok OAuth ──
//
// SuperGrok / X Premium+ subscription auth. Lives next to the OpenAI and
// Anthropic auth blocks. OAuth bearer is wire-identical to XAI_API_KEY on
// api.x.ai/v1, so the existing openai-http adapter consumes either.

async function checkXaiAuth() {
  try {
    const d = await apiJson('/api/auth/xai/status');
    const el = document.getElementById('xai-auth-status');
    const loginBtn = document.getElementById('btn-xai-login');
    const discBtn = document.getElementById('btn-xai-disconnect');
    if (!el) return;
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
  } catch {}
}

async function doXaiLogin() {
  const btn = document.getElementById('btn-xai-login');
  if (btn) { btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Opening browser...'; setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 4000); }
  try {
    const d = await apiPost('/api/auth/xai/login', {});
    // Server spawns the browser itself (more reliable in Electron than
    // window.open for long OAuth URLs). Only fall back to window.open if
    // the server-side launch didn't take.
    if (d.authUrl && !d.opened) window.open(d.authUrl, '_blank');
    // Poll for completion — xAI's callback flips the token file but
    // doesn't notify the UI directly.
    setTimeout(checkXaiAuth, 5000);
    setTimeout(checkXaiAuth, 15000);
    setTimeout(checkXaiAuth, 30000);
  } catch (e) { console.error('xAI login failed:', e); }
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
