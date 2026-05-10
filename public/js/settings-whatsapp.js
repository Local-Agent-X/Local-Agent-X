// ── Settings: WhatsApp Bridge ──
//
// QR-pair / status / connect / disconnect / reset for the WhatsApp bridge.
// Backend lives in src/whatsapp-bridge.ts. Polls /api/whatsapp/status every
// 3s while connecting (auto-stops after 2min so a stuck "scan QR" page
// doesn't burn a request loop forever).
//
// Extracted from settings.js as part of the 400-LOC god-file split.
//
// External deps from shared.js:
//   apiJson, apiPost, AUTH_TOKEN

let _waPollTimer = null;

async function waCheckStatus() {
  try {
    const d = await apiJson('/api/whatsapp/status');
    const stateEl = document.getElementById('wa-state');
    const phoneEl = document.getElementById('wa-phone');
    const badgeEl = document.getElementById('wa-badge');
    const errorEl = document.getElementById('wa-error');
    const qrBox = document.getElementById('wa-qr-box');
    const connectBtn = document.getElementById('wa-connect-btn');
    const disconnectBtn = document.getElementById('wa-disconnect-btn');
    if (!stateEl) return d;

    errorEl && (errorEl.style.display = 'none');

    if (d.state === 'connected') {
      stateEl.textContent = 'Connected';
      stateEl.style.color = 'var(--accent)';
      phoneEl.textContent = d.phone ? '+' + d.phone : '';
      badgeEl.textContent = 'CONNECTED';
      badgeEl.style.background = 'var(--accent)'; badgeEl.style.color = '#000';
      if (qrBox) qrBox.style.display = 'none';
      if (connectBtn) connectBtn.style.display = 'none';
      if (disconnectBtn) disconnectBtn.style.display = '';
      waStopPoll();
    } else if (d.state === 'qr' && (d.qrImageUrl || d.qr)) {
      stateEl.textContent = 'Scan QR Code';
      stateEl.style.color = 'var(--warn)';
      phoneEl.textContent = 'Waiting for scan...';
      badgeEl.textContent = 'SCAN ME'; badgeEl.style.background = 'var(--warn)'; badgeEl.style.color = '#000';
      if (qrBox) qrBox.style.display = '';
      if (connectBtn) connectBtn.style.display = 'none';
      if (disconnectBtn) disconnectBtn.style.display = '';
      const img = document.getElementById('wa-qr-img');
      if (img && d.qrImageUrl) img.src = d.qrImageUrl;
      waStartPoll();
    } else if (d.state === 'disconnected') {
      stateEl.textContent = 'Disconnected'; stateEl.style.color = 'var(--muted)';
      phoneEl.textContent = d.hasSavedSession ? 'Saved session — click Connect to resume' : 'Not set up';
      badgeEl.textContent = 'OFF'; badgeEl.style.background = 'var(--border)'; badgeEl.style.color = 'var(--muted)';
      if (qrBox) qrBox.style.display = 'none';
      if (connectBtn) connectBtn.style.display = '';
      if (disconnectBtn) disconnectBtn.style.display = 'none';
      if (d.error && errorEl) { errorEl.textContent = d.error; errorEl.style.display = ''; }
      waStopPoll();
    } else {
      stateEl.textContent = 'Connecting...'; stateEl.style.color = 'var(--info)';
      phoneEl.textContent = '';
      badgeEl.textContent = 'CONNECTING'; badgeEl.style.background = 'var(--info)'; badgeEl.style.color = '#000';
      if (connectBtn) connectBtn.style.display = 'none';
      waStartPoll();
    }
    return d;
  } catch (e) {
    waStopPoll();
    return null;
  }
}

function waStartPoll() {
  if (_waPollTimer) return;
  _waPollTimer = setInterval(waCheckStatus, 3000);
  setTimeout(() => waStopPoll(), 120000);
}
function waStopPoll() {
  if (_waPollTimer) { clearInterval(_waPollTimer); _waPollTimer = null; }
}

async function waConnect() {
  const btn = document.getElementById('wa-connect-btn');
  if (btn) { btn.textContent = 'Connecting...'; btn.disabled = true; }
  try {
    await apiPost('/api/whatsapp/connect', {});
    waStartPoll();
    await waCheckStatus();
  } catch (e) {
    console.error('WhatsApp connect failed:', e);
  }
  if (btn) { btn.textContent = 'Connect'; btn.disabled = false; }
}

async function waDisconnect() {
  if (!confirm('Disconnect WhatsApp?')) return;
  try { await apiPost('/api/whatsapp/disconnect', {}); } catch {}
  await waCheckStatus();
}

async function waReset() {
  if (!confirm('Clear saved session? You will need to scan QR again.')) return;
  try {
    console.log('[wa] Resetting...');
    await apiPost('/api/whatsapp/reset', {});
    console.log('[wa] Reset done');
  } catch (e) {
    console.error('[wa] Reset failed:', e);
  }
  await waCheckStatus();
}

// Browser-console debug helper. Posts /api/whatsapp/connect and dumps the
// raw response — used when waConnect's UI side hides what came back.
async function waTestConnect() {
  console.log('[wa] Testing connect...');
  try {
    const r = await fetch('/api/whatsapp/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AUTH_TOKEN },
      body: '{}',
    });
    console.log('[wa] Response status:', r.status);
    const d = await r.json();
    console.log('[wa] Response:', d);
  } catch (e) {
    console.error('[wa] Failed:', e);
  }
}
