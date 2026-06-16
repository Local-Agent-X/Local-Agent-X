// ── Settings: Mobile (enable toggle + Pair a phone + paired-devices) ──
//
// Companion UI for the bridge enable/pairing flow (constitution §4/§6/§7).
// Drives the routes:
//   GET  /api/bridge/status              → { enabled, persisted, envForced, hasTailnet }
//   POST /api/bridge/enabled  { enabled } → { enabled, restartRequired }  (toggle)
//   POST /api/bridge/pair/issue          → { tailnetAddr, pairingSecret, expiresAt, qrPayload }
//   GET  /api/bridge/devices             → device list
//   POST /api/bridge/devices/:id/revoke  → { revoked }
//
// Enabling the bridge is a persisted setting that takes effect on RESTART (the
// tailnet bind happens at server startup). So the toggle POSTs the flag, then we
// surface a "Restart to apply" button wired to the existing desktop relaunch
// (window.desktop.relaunchApp). The QR/devices panel only shows once the bridge
// is actually bound (status.enabled), i.e. after the restart.
//
// The QR encodes `qrPayload` VERBATIM — the exact string the server built
// (`{v:1,tailnetAddr,pairingSecret,expiresAt}`), so the rendered QR can't drift
// from the mobile parser. We never log the pairingSecret or device tokens.
//
// External globals: apiFetch, apiJson, apiPost, esc, LaxQR, window.desktop.

let _mobileTtlTimer = null;
let _mobileBridgeEnabled = null;
// Tracks the saved flag the server reports so we know when the toggle has
// diverged from the running (bound) state and a restart is pending.
let _mobileBridgePersisted = null;

// Refresh bridge state, then show the right sub-panels + toggle position.
async function mobileCheckBridge() {
  const panel = document.getElementById('stab-mobile');
  if (!panel) return;
  try {
    const d = await apiJson('/api/bridge/status');
    mobileRenderGating(d);
  } catch {
    // Older server without /status, or transient error — assume off and render
    // the toggle in the off state rather than a broken panel.
    mobileRenderGating({ enabled: false, persisted: false, envForced: false, hasTailnet: false });
  }
}

function mobileRenderGating(d) {
  _mobileBridgeEnabled = !!d.enabled;
  _mobileBridgePersisted = !!d.persisted;
  const envForced = !!d.envForced;

  // Toggle reflects the SAVED flag (what the next restart will apply), or the
  // env override when forced on. Disable it when env-forced (the toggle can't
  // override an env var).
  const tog = document.getElementById('tog-mobile-bridge');
  if (tog) {
    const on = _mobileBridgePersisted || envForced;
    tog.classList.toggle('on', on);
    tog.style.opacity = envForced ? '0.5' : '';
    tog.style.pointerEvents = envForced ? 'none' : '';
  }
  const envNote = document.getElementById('mobile-env-note');
  if (envNote) envNote.style.display = envForced ? '' : 'none';
  const envEl = document.getElementById('mobile-env-var');
  if (envEl) envEl.textContent = d.envVar || 'LAX_BRIDGE_ENABLED';

  // Pending-restart: the saved flag differs from the running (bound) state.
  const pending = (_mobileBridgePersisted || envForced) !== _mobileBridgeEnabled;
  mobileShowRestartBanner(pending, _mobileBridgePersisted || envForced);

  // Tailscale-down note: enabled (bound or pending) but no tailnet addr.
  const tsNote = document.getElementById('mobile-tailscale-note');
  if (tsNote) tsNote.style.display = (_mobileBridgeEnabled && !d.hasTailnet) ? '' : 'none';

  // QR/devices panel only when the bridge is actually bound.
  const enabledBox = document.getElementById('mobile-enabled-box');
  if (_mobileBridgeEnabled) {
    if (enabledBox) enabledBox.style.display = '';
    mobileLoadDevices();
  } else {
    if (enabledBox) enabledBox.style.display = 'none';
    mobileStopTtl();
  }
}

function mobileShowRestartBanner(show, willBeEnabled) {
  const banner = document.getElementById('mobile-restart-banner');
  const msg = document.getElementById('mobile-restart-msg');
  if (!banner) return;
  banner.style.display = show ? '' : 'none';
  if (show && msg) {
    msg.textContent = willBeEnabled
      ? 'Mobile bridge will turn ON after a restart.'
      : 'Mobile bridge will turn OFF after a restart.';
  }
}

// Toggle handler: persist the flag, then surface restart-to-apply. We do NOT
// flip _mobileBridgeEnabled (the live/bound state) here — that only changes on
// restart. We optimistically reflect the new SAVED state in the switch.
async function mobileToggleBridge(el) {
  if (!el || el.style.pointerEvents === 'none') return; // env-forced: locked
  const next = !el.classList.contains('on');
  el.classList.toggle('on', next);
  try {
    const res = await apiFetch('/api/bridge/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    _mobileBridgePersisted = !!d.enabled;
    mobileShowRestartBanner(_mobileBridgePersisted !== _mobileBridgeEnabled, _mobileBridgePersisted);
  } catch (e) {
    // Revert the switch and tell the user.
    el.classList.toggle('on', !next);
    alert('Could not change the mobile bridge: ' + ((e && e.message) ? e.message : String(e)));
  }
}

// Restart-to-apply: reuse the existing desktop relaunch. Browser-only users
// (no Electron) get a plain instruction instead.
async function mobileRestartToApply(btn) {
  if (window.desktop && window.desktop.relaunchApp) {
    if (btn) { btn.disabled = true; btn.textContent = 'Restarting…'; }
    try { await window.desktop.relaunchApp(); }
    catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Restart to apply'; }
      alert('Restart failed: ' + ((e && e.message) ? e.message : String(e)));
    }
  } else {
    alert('Quit and reopen Local Agent X to apply the change.');
  }
}

// ── QR generation ──

async function mobileGenerateCode() {
  const btn = document.getElementById('mobile-gen-btn');
  const qrBox = document.getElementById('mobile-qr-box');
  const qrImg = document.getElementById('mobile-qr-render');
  const errEl = document.getElementById('mobile-pair-error');
  const addrEl = document.getElementById('mobile-tailnet-addr');
  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  mobileStopTtl();
  try {
    const res = await apiFetch('/api/bridge/pair/issue', { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.qrPayload) {
      throw new Error(d.error || 'Could not issue a pairing code.');
    }
    // Encode the server's verbatim payload string — no client-side reshaping.
    if (typeof LaxQR === 'undefined') throw new Error('QR generator failed to load.');
    const matrix = LaxQR.encodeText(d.qrPayload, 'M');
    if (qrImg) qrImg.innerHTML = LaxQR.toSvg(matrix, { border: 2 });
    if (addrEl) addrEl.textContent = d.tailnetAddr || '';
    if (qrBox) qrBox.style.display = '';
    mobileStartTtl(d.expiresAt);
  } catch (e) {
    if (qrBox) qrBox.style.display = 'none';
    if (errEl) { errEl.textContent = (e && e.message) ? e.message : String(e); errEl.style.display = ''; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate new code'; }
  }
}

// ── TTL countdown ──

function mobileStartTtl(expiresAt) {
  mobileStopTtl();
  const ttlEl = document.getElementById('mobile-ttl');
  const qrImg = document.getElementById('mobile-qr-render');
  const tick = () => {
    const remaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (ttlEl) {
      if (remaining > 0) {
        ttlEl.textContent = `Expires in ${remaining}s`;
        ttlEl.style.color = remaining <= 10 ? 'var(--warn)' : 'var(--muted)';
      } else {
        ttlEl.textContent = 'Code expired — generate a new one';
        ttlEl.style.color = 'var(--danger)';
      }
    }
    if (remaining <= 0) {
      mobileStopTtl();
      // Dim the stale QR so nobody scans a dead code.
      if (qrImg) qrImg.style.opacity = '0.25';
    }
  };
  if (qrImg) qrImg.style.opacity = '1';
  tick();
  _mobileTtlTimer = setInterval(tick, 1000);
}

function mobileStopTtl() {
  if (_mobileTtlTimer) { clearInterval(_mobileTtlTimer); _mobileTtlTimer = null; }
}

// ── Paired-devices list ──

function mobileFmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function mobileRelative(ms) {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function mobileLoadDevices() {
  const listEl = document.getElementById('mobile-devices-list');
  if (!listEl) return;
  listEl.textContent = 'Loading…';
  try {
    const res = await apiFetch('/api/bridge/devices');
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    const devices = await res.json();
    if (!Array.isArray(devices) || devices.length === 0) {
      listEl.innerHTML = '<div style="font-size:.78rem;color:var(--muted);padding:8px 0">No devices paired yet. Generate a code above and scan it with the AgentXOS app.</div>';
      return;
    }
    listEl.innerHTML = mobileDevicesTable(devices);
  } catch (e) {
    listEl.innerHTML = `<div style="color:var(--danger);font-size:.78rem">Could not load devices: ${esc((e && e.message) ? e.message : String(e))}</div>`;
  }
}

function mobileDevicesTable(devices) {
  const rows = devices.map((dev) => {
    const revoked = dev.status === 'revoked';
    const statusBadge = revoked
      ? '<span style="font-size:.62rem;padding:2px 8px;border-radius:4px;background:var(--border);color:var(--danger)">REVOKED</span>'
      : '<span style="font-size:.62rem;padding:2px 8px;border-radius:4px;background:var(--accent);color:#000">ACTIVE</span>';
    const action = revoked
      ? '<span style="font-size:.72rem;color:var(--muted)">—</span>'
      : `<button class="action-btn" style="color:var(--danger);padding:3px 12px;font-size:.72rem" onclick="mobileRevoke('${esc(dev.id)}', this)">Revoke</button>`;
    return `<tr style="border-top:1px solid var(--border)">
      <td style="padding:8px 10px;font-size:.8rem">${esc(dev.label || 'Unnamed device')}</td>
      <td style="padding:8px 10px;font-size:.74rem;color:var(--muted)">${esc(mobileFmtTime(dev.pairedAt))}</td>
      <td style="padding:8px 10px;font-size:.74rem;color:var(--muted)">${esc(mobileRelative(dev.lastSeen))}</td>
      <td style="padding:8px 10px">${statusBadge}</td>
      <td style="padding:8px 10px;text-align:right">${action}</td>
    </tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse">
    <thead><tr style="text-align:left">
      <th style="padding:6px 10px;font-size:.66rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Device</th>
      <th style="padding:6px 10px;font-size:.66rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Paired</th>
      <th style="padding:6px 10px;font-size:.66rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Last seen</th>
      <th style="padding:6px 10px;font-size:.66rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Status</th>
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function mobileRevoke(id, btn) {
  if (!confirm('Revoke this device? It will be disconnected immediately and must re-pair to reconnect.')) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Revoking…'; }
  try {
    const res = await apiFetch(`/api/bridge/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  } catch (e) {
    alert('Revoke failed: ' + ((e && e.message) ? e.message : String(e)));
  } finally {
    // Reflect the new state from the server regardless of the button's fate.
    mobileLoadDevices();
  }
}
