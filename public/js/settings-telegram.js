// ── Settings: Telegram Bot ──
//
// Token-pair / status / connect / disconnect for the Telegram bot bridge.
// Backend lives in src/telegram-bridge/. Token is saved to the secrets
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
    tgRenderOwner(d);

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
  try { await apiPost('/api/telegram/disconnect', {}); }
  catch (e) { console.error('Telegram disconnect failed:', e); }
  await tgCheckStatus();
}

// ── Owner claim ──
//
// A bot token carries no identity, so ownership can't be inferred the way
// WhatsApp infers it from the paired account. The operator opens a short
// claim window here; the next chat to message the bot locks it.

let tgClaimTimer = null;

function tgRenderOwner(d) {
  const box = document.getElementById('tg-owner-box');
  if (!box) return;
  box.style.display = d.state === 'connected' ? '' : 'none';
  if (d.state !== 'connected') { tgStopClaimCountdown(); return; }

  const stateEl = document.getElementById('tg-owner-state');
  const claimBtn = document.getElementById('tg-claim-btn');
  const clearBtn = document.getElementById('tg-clear-owner-btn');
  const owned = (d.allowedChatIds || []).length > 0;
  const msLeft = d.claimWindowMsRemaining || 0;

  if (owned) {
    stateEl.textContent = 'Locked to chat ' + d.allowedChatIds.join(', ');
    stateEl.style.color = 'var(--accent)';
    claimBtn.style.display = 'none';
    clearBtn.style.display = '';
    tgStopClaimCountdown();
  } else if (msLeft > 0) {
    stateEl.style.color = 'var(--warn)';
    claimBtn.disabled = true;
    clearBtn.style.display = 'none';
    tgStartClaimCountdown(Date.now() + msLeft);
  } else {
    stateEl.textContent = 'Unowned — nobody can message this bot yet.';
    stateEl.style.color = 'var(--muted)';
    claimBtn.style.display = '';
    claimBtn.disabled = false;
    clearBtn.style.display = 'none';
    tgStopClaimCountdown();
  }
}

function tgStartClaimCountdown(endsAt) {
  tgStopClaimCountdown();
  const tick = () => {
    const left = Math.ceil((endsAt - Date.now()) / 1000);
    const stateEl = document.getElementById('tg-owner-state');
    if (!stateEl) return tgStopClaimCountdown();
    if (left <= 0) { tgStopClaimCountdown(); tgCheckStatus(); return; }
    stateEl.textContent = 'Claim window open — message your bot now (' + left + 's left)';
    // Poll status so the panel flips to "Locked to chat N" the moment the
    // claim lands, without the user having to reopen settings.
    if (left % 3 === 0) tgCheckStatus();
  };
  tick();
  tgClaimTimer = setInterval(tick, 1000);
}

function tgStopClaimCountdown() {
  if (tgClaimTimer) { clearInterval(tgClaimTimer); tgClaimTimer = null; }
}

function tgOwnerError(msg) {
  const el = document.getElementById('tg-owner-error');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? '' : 'none';
}

async function tgClaimOwner() {
  tgOwnerError('');
  try {
    const d = await apiPost('/api/telegram/claim', {});
    if (!d.ok) { tgOwnerError(d.error || 'Could not open claim window'); return; }
  } catch (e) {
    tgOwnerError('Could not open claim window'); return;
  }
  await tgCheckStatus();
}

async function tgSaveOwner() {
  const input = document.getElementById('tg-owner-input');
  const chatId = input?.value?.trim();
  if (!chatId) { tgOwnerError('Enter a chat ID first.'); return; }
  tgOwnerError('');
  try {
    const d = await apiPost('/api/telegram/owner', { chatIds: [chatId] });
    if (d.error) { tgOwnerError(d.error); return; }
    if (input) input.value = '';
  } catch (e) {
    tgOwnerError('Could not save owner'); return;
  }
  await tgCheckStatus();
}

async function tgClearOwner() {
  if (!confirm('Clear the Telegram owner? Nobody will be able to message the bot until it is claimed again.')) return;
  tgOwnerError('');
  try { await apiPost('/api/telegram/owner', { chatIds: [] }); }
  catch (e) { tgOwnerError('Could not clear owner'); return; }
  await tgCheckStatus();
}
