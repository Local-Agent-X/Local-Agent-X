// ── Settings: Telegram Bot ──
//
// Token-pair / status / connect / disconnect for the Telegram bot bridge.
// Backend lives in src/telegram-bridge.ts. Token is saved to the secrets
// vault (POST /api/secrets) BEFORE /api/telegram/connect so the worker
// can pick it up without ever round-tripping the plaintext token through
// settings.json.
//
// Extracted from settings.js as part of the 400-LOC god-file split.
//
// External deps from shared.js:
//   apiJson, apiPost

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
    // Save token to secrets vault first (if provided) — keeps the plaintext
    // token out of settings.json round-trips.
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
