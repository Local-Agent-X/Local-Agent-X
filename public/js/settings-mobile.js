// ── Settings: Mobile (Pair a phone + paired-devices) ──
//
// Companion UI for the bridge pairing flow (constitution §4/§7). Drives the
// chunk-1 routes:
//   GET  /api/bridge/status              → { enabled } (works when disabled)
//   POST /api/bridge/pair/issue          → { tailnetAddr, pairingSecret, expiresAt, qrPayload }
//   GET  /api/bridge/devices             → device list
//   POST /api/bridge/devices/:id/revoke  → { revoked }
//
// The QR encodes `qrPayload` VERBATIM — the exact string the server built
// (`{v:1,tailnetAddr,pairingSecret,expiresAt}`), so the rendered QR can't drift
// from the mobile parser. We never log the pairingSecret or device tokens.
//
// Rendering uses the vendored, network-free QR generator at /vendor/qr.
//
// External globals: apiFetch, apiJson, apiPost, esc, LaxQR.

let _mobileTtlTimer = null;
let _mobileBridgeEnabled = null;

// Refresh whether the bridge is enabled, then show the right sub-panel.
async function mobileCheckBridge() {
  const panel = document.getElementById('stab-mobile');
  if (!panel) return;
  try {
    const d = await apiJson('/api/bridge/status');
    _mobileBridgeEnabled = !!d.enabled;
    mobileRenderGating(d.envVar || 'LAX_BRIDGE_ENABLED');
  } catch {
    // Older server without /status, or transient error — assume disabled and
    // surface the hint rather than a broken panel.
    _mobileBridgeEnabled = false;
    mobileRenderGating('LAX_BRIDGE_ENABLED');
  }
}

function mobileRenderGating(envVar) {
  const enabledBox = document.getElementById('mobile-enabled-box');
  const disabledBox = document.getElementById('mobile-disabled-box');
  const envEl = document.getElementById('mobile-env-var');
  if (envEl) envEl.textContent = envVar;
  if (_mobileBridgeEnabled) {
    if (enabledBox) enabledBox.style.display = '';
    if (disabledBox) disabledBox.style.display = 'none';
    mobileLoadDevices();
  } else {
    if (enabledBox) enabledBox.style.display = 'none';
    if (disabledBox) disabledBox.style.display = '';
    mobileStopTtl();
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
