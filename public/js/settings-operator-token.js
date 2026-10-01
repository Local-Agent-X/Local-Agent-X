// ── Settings: the operator credential ──
//
// The token this UI authenticates with. It never expires on its own, so
// rotating it here is the one control against a leaked token (a screenshot of
// a URL, a pasted log). Rotation persists the new token on the server; in the
// desktop app the server restarts and the window reloads with the new token
// by itself. In a plain browser this page keeps the new token and the user
// restarts the server by hand, since the chat socket holds the old one.
//
// External deps (runtime globals): apiFetch (shared-api.js).

function renderOperatorToken(d) {
  const when = document.getElementById('operator-token-rotated');
  if (when) {
    when.textContent = d && d.rotatedAt
      ? 'Last rotated ' + new Date(d.rotatedAt).toLocaleString() + '. It does not expire on its own.'
      : 'Never rotated. It does not expire on its own.';
  }
  const hint = document.getElementById('operator-token-hint');
  if (hint) {
    hint.textContent = d && d.restart === 'desktop'
      ? 'Rotating restarts the app’s server and reloads this window with the new credential. Other open tabs need the new link from the app menu.'
      : 'Rotating saves the new credential; restart the server afterwards so the chat connection picks it up.';
  }
}

async function loadOperatorToken() {
  try {
    const r = await apiFetch('/api/security/operator-token');
    if (!r.ok) return;
    renderOperatorToken(await r.json());
  } catch (e) { console.warn('[operator-token] load failed', e); }
}

async function rotateOperatorTokenUI() {
  const btn = document.getElementById('operator-token-rotate');
  const status = document.getElementById('operator-token-status');
  if (!confirm('Rotate the operator credential? The old token stops working immediately and the app restarts its server.')) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Rotating…'; }
  try {
    const r = await apiFetch('/api/security/operator-token/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.token) {
      if (status) status.textContent = d.error || 'Rotation failed.';
      if (btn) { btn.disabled = false; btn.textContent = 'Rotate operator credential'; }
      return;
    }
    // This page keeps working on the new token: shared.js reads lax_token.
    try { localStorage.setItem('lax_token', d.token); sessionStorage.setItem('lax_token', d.token); } catch {}
    if (status) {
      status.textContent = d.restart === 'desktop'
        ? 'Rotated. Restarting the server and reloading with the new credential…'
        : 'Rotated. Restart the server now; this tab already holds the new credential.';
    }
    if (d.restart !== 'desktop') {
      if (btn) { btn.disabled = false; btn.textContent = 'Rotate operator credential'; }
      await loadOperatorToken();
    }
  } catch (e) {
    console.warn('[operator-token] rotate failed', e);
    if (status) status.textContent = 'Rotation failed.';
    if (btn) { btn.disabled = false; btn.textContent = 'Rotate operator credential'; }
  }
}

document.addEventListener('DOMContentLoaded', loadOperatorToken);
