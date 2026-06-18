// ── Settings: Onboarding Wizard — OAuth / sign-in flow ──
//
// The connect-step OAuth providers (OpenAI, Anthropic, xAI): status polling,
// the "Signed in" confirmation render, the login kickoff, and the
// paste-the-code exchanges for Anthropic + xAI.
//
// Extracted from settings-onboarding.js as part of the 400-LOC god-file split.
//
// Runtime deps on the wizard shell (settings-onboarding.js): reads
// `_onboardStep` / `_onboardProvider`. Those are referenced only inside
// function bodies (runtime), never at load time — this file loads standalone.
//
// External deps:
//   apiFetch, apiPost   (shared.js)
//   checkAuth           (app.js)

// OAuth providers reachable from the connect step. All three status routes
// return { authenticated }. `label` is what the signed-in confirmation shows.
const OB_OAUTH = {
  openai:    { endpoint: '/api/auth/status',           label: 'OpenAI' },
  anthropic: { endpoint: '/api/auth/anthropic/status', label: 'Claude' },
  xai:       { endpoint: '/api/auth/xai/status',        label: 'xAI' },
};

let _onboardAuthPoll = null;

function stopOnboardAuthPoll() {
  if (_onboardAuthPoll) { clearInterval(_onboardAuthPoll); _onboardAuthPoll = null; }
}

async function obIsAuthed(type) {
  const cfg = OB_OAUTH[type];
  if (!cfg) return false;
  try {
    const r = await apiFetch(cfg.endpoint);
    const s = await r.json();
    return !!s.authenticated;
  } catch { return false; }
}

// Replace the sign-in button + key field with a "Signed in" confirmation.
function renderOnboardConnected(type) {
  stopOnboardAuthPoll();
  const cfg = OB_OAUTH[type] || { label: 'your account' };
  const container = document.getElementById('ob-connect-content');
  const desc = document.getElementById('ob-connect-desc');
  const status = document.getElementById('ob-connect-status');
  if (desc) desc.textContent = "You're connected.";
  if (status) status.textContent = '';
  if (!container) return;
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;color:var(--accent);font-size:1.05rem;font-weight:600;text-shadow:0 0 12px var(--accent-dim)">
      <span style="font-size:1.2rem">✓</span> Signed in with ${cfg.label}
    </div>
    <span style="color:var(--muted);font-size:.72rem;margin-top:6px;max-width:320px;line-height:1.5">
      Click Next to continue. To use a different provider, hit <strong style="color:var(--text)">Back</strong> and pick another.
    </span>`;
}

function startOnboardAuthPoll(type) {
  stopOnboardAuthPoll();
  let attempts = 0;
  _onboardAuthPoll = setInterval(async () => {
    attempts++;
    if (await obIsAuthed(type)) {
      // Guard against a late tick landing after the user navigated away.
      if (_onboardStep === 2) renderOnboardConnected(type);
      else stopOnboardAuthPoll();
      if (typeof checkAuth === 'function') checkAuth(); // refresh sidebar dot
      return;
    }
    if (attempts > 150) stopOnboardAuthPoll(); // ~5min @ 2s
  }, 2000);
}

async function onboardOAuth(type) {
  const status = document.getElementById('ob-connect-status');
  const endpoints = {
    // Anthropic subscription auth is CLI-only — Anthropic doesn't accept
    // subscription tokens outside the official claude CLI. The paste-the-code
    // flow exchanges the code and writes ~/.claude/.credentials.json, which
    // chat + build_app both read.
    anthropic: '/api/auth/anthropic/cli-login',
    xai: '/api/auth/xai/login',
  };
  try {
    const endpoint = endpoints[type] || '/api/auth/login';
    const res = await apiPost(endpoint, {});
    if (res.authUrl) {
      // Anthropic uses paste-the-code: open the authorize page, then show a box
      // for the code it displays. No polling — completion is the code submit.
      if (type === 'anthropic') {
        window.open(res.authUrl, '_blank', 'noopener');
        const container = document.getElementById('ob-connect-content');
        if (container) {
          container.innerHTML =
            '<div style="font-size:.85rem;line-height:1.5;max-width:380px;text-align:center">' +
            'Approve in the browser tab that just opened (or <a href="' + res.authUrl + '" target="_blank" rel="noopener">open it again</a>), ' +
            'then paste the code it shows:</div>' +
            '<input type="text" id="ob-anthropic-code" placeholder="paste code from the authorization page" style="width:100%;max-width:380px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:.85rem;font-family:var(--mono)">' +
            '<div style="display:flex;gap:8px;justify-content:center">' +
            '  <button class="action-btn" onclick="onboardPasteAnthropicCode()" style="padding:8px 24px" title="Paste the copied code from your clipboard">Paste</button>' +
            '  <button class="action-btn primary" onclick="onboardSubmitAnthropicCode()" style="padding:8px 24px">Finish sign-in</button>' +
            '</div>';
          const inp = document.getElementById('ob-anthropic-code');
          if (inp) { inp.focus(); inp.addEventListener('keydown', e => { if (e.key === 'Enter') onboardSubmitAnthropicCode(); }); }
        }
        if (status) { status.style.color = ''; status.textContent = 'Browser opened — approve, then paste the code here.'; }
        return;
      }
      // NEVER trust res.opened: the server's rundll32 launch silently no-ops on
      // some Windows setups while still reporting opened:true, and programmatic
      // window.open is dropped by Chromium for these long URLs in the Electron
      // wrapper. Always render a clickable link — a real <a> click routes through
      // Electron's window-open handler -> shell.openExternal, the one reliable
      // path (same fix as settings-xai.js showXaiOpenFallback).
      try { window.open(res.authUrl, '_blank', 'width=600,height=700'); } catch {}
      if (status) {
        status.innerHTML = '';
        const note = document.createElement('div');
        note.textContent = "If the xAI sign-in page didn't open, click here:";
        note.style.marginBottom = '6px';
        const link = document.createElement('a');
        link.href = res.authUrl; link.target = '_blank'; link.rel = 'noopener';
        link.textContent = 'Open xAI sign-in page';
        link.style.color = 'var(--accent)'; link.style.fontWeight = '600';
        status.appendChild(note); status.appendChild(link);
      }
      // Watch for completion and flip the step to the signed-in state.
      startOnboardAuthPoll(type);
    } else if (res.error) {
      if (status) status.textContent = 'Error: ' + res.error;
    }
  } catch (e) {
    if (status) status.textContent = 'Failed to start sign-in. Try again or set up in Settings later.';
  }
}

async function onboardPasteAnthropicCode() {
  const input = document.getElementById('ob-anthropic-code');
  const status = document.getElementById('ob-connect-status');
  try {
    const text = String((await navigator.clipboard.readText()) || '').trim();
    if (!text) { if (status) { status.style.color = ''; status.textContent = 'Clipboard is empty — copy the code on the Anthropic page first.'; } return; }
    if (input) input.value = text;
    onboardSubmitAnthropicCode();
  } catch (e) {
    if (status) { status.style.color = 'var(--err,#c33)'; status.textContent = 'Couldn’t read the clipboard. Paste manually (⌘V) and click Finish sign-in.'; }
    if (input) input.focus();
  }
}

async function onboardSubmitAnthropicCode() {
  const input = document.getElementById('ob-anthropic-code');
  const status = document.getElementById('ob-connect-status');
  const code = (input?.value || '').trim();
  if (!code) { if (status) { status.style.color = ''; status.textContent = 'Paste the code first.'; } return; }
  if (status) { status.style.color = ''; status.textContent = 'Exchanging code…'; }
  try {
    await apiPost('/api/auth/anthropic/cli-login-submit', { code });
    _onboardProvider = 'anthropic';
    if (typeof checkAuth === 'function') checkAuth();
    renderOnboardConnected('anthropic');
  } catch (e) {
    if (status) { status.style.color = 'var(--err,#c33)'; status.textContent = (e && e.message) || 'Code exchange failed. Click Sign In with Claude and try again.'; }
  }
}

async function onboardExchangeXaiCode() {
  const input = document.getElementById('ob-xai-code');
  const status = document.getElementById('ob-connect-status');
  const code = (input?.value || '').trim();
  if (!code) { if (status) status.textContent = 'Paste the code from xAI first.'; return; }
  try {
    const r = await apiPost('/api/auth/xai/exchange-code', { code });
    if (r && r.error) throw new Error(r.error);
    // Verify the token actually landed before claiming success — the exchange
    // POST returning isn't proof (a revoked token would still "succeed" here).
    const st = await apiJson('/api/auth/xai/status');
    if (st && st.authenticated) {
      if (status) { status.style.color = 'var(--accent)'; status.textContent = 'Connected to xAI! Click Next to continue.'; }
      if (input) { input.value = ''; input.placeholder = '••••••••  (connected)'; }
    } else if (status) {
      status.textContent = 'Code accepted but not connected — the token may be revoked. Sign in again.';
    }
  } catch (e) {
    if (status) status.textContent = 'Code exchange failed: ' + (e?.message || 'unknown') + '. Make sure Sign In was clicked first.';
  }
}
