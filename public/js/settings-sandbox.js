// ── Settings: Bash Sandbox Mode ──
//
// Controls how the bash tool's commands are confined. Persists to
// ~/.lax/config.json via /api/sandbox.
//
const SANDBOX_HINTS = {
  guarded: 'Bash runs under a kernel cage that blocks reads of your credential files (~/.ssh, ~/.aws, API keys) — even via indirection a text filter would miss — while keeping network and dev tools (npm/git/gh) working. Recommended.',
  host: 'Bash runs directly on your host with no kernel cage. Full functionality, but a prompt-injected command could read credential files.',
  docker: 'Bash runs inside a Docker container (Alpine Linux, --network=none, workspace-only). Strongest isolation, but breaks host-OS commands and network access.'
};

function renderSandboxStatus(d) {
  const badge = document.getElementById('sandbox-effective-status');
  const detail = document.getElementById('sandbox-effective-detail');
  const actions = document.getElementById('sandbox-host-ack-actions');
  const ack = document.getElementById('sandbox-ack-btn');
  const revoke = document.getElementById('sandbox-revoke-btn');
  const effective = d.effectiveMode || d.mode || 'host';
  const confined = d.confined === true;
  if (badge) {
    badge.className = 'status-badge ' + (confined ? 'ok' : 'err');
    badge.innerHTML = '<span class="status-dot"></span> Effective: ' + (confined ? effective + ' confined' : 'HOST UNCONFINED');
  }
  if (detail) {
    if (confined) detail.textContent = 'Cron shell is blocked. Delegated and API shell are allowed because the effective mode is confined.';
    else if (d.unconfinedHostAcknowledged) detail.textContent = (d.fallbackReason || 'Shell commands run directly on the host.') + ' Cron shell is blocked; delegated and API host shell are acknowledged.';
    else detail.textContent = (d.fallbackReason || 'Shell commands run directly on the host.') + ' Cron shell is blocked; delegated and API shell are blocked until acknowledgement.';
  }
  if (actions) actions.style.display = confined ? 'none' : '';
  if (ack) ack.style.display = !confined && !d.unconfinedHostAcknowledged ? '' : 'none';
  if (revoke) revoke.style.display = !confined && d.unconfinedHostAcknowledged ? '' : 'none';
}

// The Windows network cage (src/sandbox/win-cage.ts): shown only when the
// server reports it, i.e. on Windows. Installing or removing it takes one
// administrator prompt, which appears on the desktop, not in this page.
function renderWindowsCage(cage) {
  const box = document.getElementById('sandbox-windows-cage');
  if (!box) return;
  if (!cage) { box.style.display = 'none'; return; }
  box.style.display = '';
  const detail = document.getElementById('sandbox-windows-cage-detail');
  const install = document.getElementById('sandbox-windows-cage-install');
  const uninstall = document.getElementById('sandbox-windows-cage-uninstall');
  if (detail) detail.textContent = 'Windows network cage: ' + (cage.detail || '');
  const helperMissing = !cage.helper;
  if (install) { install.style.display = cage.installed || helperMissing ? 'none' : ''; install.disabled = false; install.textContent = 'Install the Windows network cage (one administrator prompt)'; }
  if (uninstall) { uninstall.style.display = cage.installed ? '' : 'none'; uninstall.disabled = false; }
}

async function windowsCageAction(action) {
  const btn = document.getElementById(action === 'install' ? 'sandbox-windows-cage-install' : 'sandbox-windows-cage-uninstall');
  const detail = document.getElementById('sandbox-windows-cage-detail');
  if (btn) { btn.disabled = true; btn.textContent = 'Waiting for the administrator prompt…'; }
  try {
    const r = await apiFetch('/api/sandbox/windows-cage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok && detail) detail.textContent = 'Windows network cage: ' + (d.detail || d.error || 'the action failed.');
    renderSandboxStatus(d);
    if (d.windowsCage) renderWindowsCage(d.windowsCage);
    else await loadSandboxMode();
  } catch (e) {
    console.warn('[sandbox] windows cage ' + action + ' failed', e);
    if (btn) btn.disabled = false;
  }
}
function installWindowsCage() { return windowsCageAction('install'); }
function uninstallWindowsCage() { return windowsCageAction('uninstall'); }

async function loadSandboxMode() {
  try {
    const r = await apiFetch('/api/sandbox');
    if (!r.ok) return;
    const d = await r.json();
    const sel = document.getElementById('cfg-sandbox-mode');
    if (sel) sel.value = d.selectedMode || d.mode || 'guarded';
    renderSandboxStatus(d);
    renderWindowsCage(d.windowsCage || null);
    const hint = document.getElementById('sandbox-hint');
    if (hint) hint.textContent = SANDBOX_HINTS[d.mode] || SANDBOX_HINTS.guarded;
    if (sel && !d.dockerAvailable) {
      const dockerOpt = sel.querySelector('option[value="docker"]');
      if (dockerOpt) {
        dockerOpt.disabled = true;
        dockerOpt.textContent = 'Maximum — Docker not installed (install Docker Desktop first)';
      }
    }
    if (sel && d.guardedAvailable === false) {
      const guardedOpt = sel.querySelector('option[value="guarded"]');
      if (guardedOpt) {
        guardedOpt.disabled = true;
        guardedOpt.textContent = d.windowsCage
          ? 'Protected — install the Windows network cage below to enable'
          : 'Protected — not available on this OS (needs macOS or Linux)';
      }
    }
  } catch (e) { console.warn('[sandbox] load failed', e); }
}

async function setSandboxModeUI(mode) {
  const hint = document.getElementById('sandbox-hint');
  if (hint) hint.textContent = SANDBOX_HINTS[mode] || '';
  try {
    const r = await apiFetch('/api/sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.warn('[sandbox] save failed', err);
      // Reflect what the server actually settled on (it downgrades an
      // unavailable mode to host) rather than guessing.
      const sel = document.getElementById('cfg-sandbox-mode');
      if (sel && err.actual) sel.value = err.actual;
      if (hint) hint.textContent = err.error || 'Failed to set sandbox mode.';
      renderSandboxStatus(err);
    } else {
      const d = await r.json();
      renderSandboxStatus(d);
    }
  } catch (e) { console.warn('[sandbox] save failed', e); }
}

async function acknowledgeUnconfinedHost() {
  const r = await apiFetch('/api/sandbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acknowledgeUnconfinedHost: true })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn('[sandbox] acknowledgement failed', d);
    const detail = document.getElementById('sandbox-effective-detail');
    if (detail) detail.textContent = d.error || 'Failed to save acknowledgement.';
    return;
  }
  renderSandboxStatus(d);
}

async function revokeUnconfinedHostAcknowledgement() {
  const r = await apiFetch('/api/sandbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revokeUnconfinedHostAcknowledgement: true })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn('[sandbox] acknowledgement revoke failed', d);
    const detail = document.getElementById('sandbox-effective-detail');
    if (detail) detail.textContent = d.error || 'Failed to revoke acknowledgement.';
    return;
  }
  renderSandboxStatus(d);
}

document.addEventListener('DOMContentLoaded', loadSandboxMode);
