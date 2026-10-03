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

// The server broadcasts settings_changed when the Windows cage's fence proof
// lands, and that reload is what clears "checking". A page whose socket was
// down misses it, so while the check (or, after it, the sandbox user's grants)
// is pending the section also re-reads the status about 5, 15 and 45 seconds
// in, then stops: the broadcast still carries a slower proof's answer, and an
// open page must not poll forever.
const SANDBOX_RECHECK_DELAYS_MS = [5000, 10000, 30000];
let sandboxRecheckTimer = null;
let sandboxRechecksUsed = 0;
function sandboxSectionPresent() {
  return document.getElementById('sandbox-effective-status') !== null;
}
function scheduleSandboxRecheck(pending) {
  clearTimeout(sandboxRecheckTimer);
  sandboxRecheckTimer = null;
  if (!pending) { sandboxRechecksUsed = 0; return; }
  const delay = SANDBOX_RECHECK_DELAYS_MS[sandboxRechecksUsed];
  if (delay === undefined || !sandboxSectionPresent()) return;
  sandboxRechecksUsed++;
  sandboxRecheckTimer = setTimeout(() => { if (sandboxSectionPresent()) loadSandboxMode(); }, delay);
}

function renderSandboxStatus(d) {
  const badge = document.getElementById('sandbox-effective-status');
  const detail = document.getElementById('sandbox-effective-detail');
  const actions = document.getElementById('sandbox-host-ack-actions');
  const ack = document.getElementById('sandbox-ack-btn');
  const revoke = document.getElementById('sandbox-revoke-btn');
  const effective = d.effectiveMode || d.mode || 'host';
  const confined = d.confined === true;
  // Guarded on Windows with the cage still being proven: not a failure, and
  // nothing runs unconfined meanwhile, so there is no host state to acknowledge.
  const pending = d.proofPending === true;
  // The Windows cage proven and in use, but its sandbox user not yet (or never)
  // given the workspace: shell commands wait or are refused, which a plain
  // "guarded confined" would hide. Only the full status read carries these.
  const cage = d.windowsCage || {};
  const grantFailure = cage.grantFailure;
  const granting = cage.grantPending === true;
  if (badge) {
    badge.className = 'status-badge ' + (pending || granting ? 'warn' : confined && !grantFailure ? 'ok' : 'err');
    badge.innerHTML = '<span class="status-dot"></span> ' + (pending ? 'Checking the Windows cage…'
      : grantFailure ? 'Effective: guarded, but shell commands are refused'
      : granting ? 'Preparing the Windows cage…'
      : 'Effective: ' + (confined ? effective + ' confined' : 'HOST UNCONFINED'));
  }
  if (detail) {
    if (pending) detail.textContent = 'Shell commands wait until the check finishes (a few seconds after start); none runs outside the cage meanwhile.';
    else if (grantFailure) detail.textContent = grantFailure;
    else if (granting) detail.textContent = 'The cage is giving its sandbox user access to the workspace and the shell\'s own files (once after each start). Shell commands wait for it or are asked to retry; none runs outside the cage.';
    else if (confined) detail.textContent = 'Cron shell is blocked. Delegated and API shell are allowed because the effective mode is confined.';
    else if (d.unconfinedHostAcknowledged) detail.textContent = (d.fallbackReason || 'Shell commands run directly on the host.') + ' Cron shell is blocked; delegated and API host shell are acknowledged.';
    else detail.textContent = (d.fallbackReason || 'Shell commands run directly on the host.') + ' Cron shell is blocked; delegated and API shell are blocked until acknowledgement.';
  }
  const unconfinedHost = !confined && !pending;
  if (actions) actions.style.display = unconfinedHost ? '' : 'none';
  if (ack) ack.style.display = unconfinedHost && !d.unconfinedHostAcknowledged ? '' : 'none';
  if (revoke) revoke.style.display = unconfinedHost && d.unconfinedHostAcknowledged ? '' : 'none';
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
  const broken = cage.installed && cage.proofFailure ? ' It is installed but not working: ' + cage.proofFailure + '.' : '';
  if (detail) detail.textContent = 'Windows network cage: ' + (cage.detail || '') + broken;
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
    scheduleSandboxRecheck(d.proofPending === true);
    if (d.windowsCage) renderWindowsCage(d.windowsCage);
    else await loadSandboxMode();
  } catch (e) {
    console.warn('[sandbox] windows cage ' + action + ' failed', e);
    if (btn) btn.disabled = false;
  }
}
function installWindowsCage() { return windowsCageAction('install'); }
function uninstallWindowsCage() { return windowsCageAction('uninstall'); }

// The section re-renders on every status change, so an option disabled while
// the cage was being checked must come back with its own label once proven.
function setSandboxModeOption(sel, value, unavailableLabel) {
  const opt = sel.querySelector('option[value="' + value + '"]');
  if (!opt) return;
  if (opt.dataset.label === undefined) opt.dataset.label = opt.textContent;
  opt.disabled = unavailableLabel !== null;
  opt.textContent = unavailableLabel === null ? opt.dataset.label : unavailableLabel;
}

function guardedUnavailableLabel(cage) {
  if (!cage) return 'Protected — not available on this OS (needs macOS or Linux)';
  if (cage.proofPending) return 'Protected — checking the Windows cage…';
  if (cage.installed) return 'Protected — the Windows network cage is installed but not working (see below)';
  return 'Protected — install the Windows network cage below to enable';
}

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
    if (hint) hint.textContent = SANDBOX_HINTS[d.proofPending ? d.selectedMode : d.mode] || SANDBOX_HINTS.guarded;
    if (sel) {
      setSandboxModeOption(sel, 'docker', d.dockerAvailable ? null : 'Maximum — Docker not installed (install Docker Desktop first)');
      setSandboxModeOption(sel, 'guarded', d.guardedAvailable === false ? guardedUnavailableLabel(d.windowsCage) : null);
    }
    const cage = d.windowsCage || {};
    scheduleSandboxRecheck(d.proofPending === true || cage.proofPending === true || cage.grantPending === true);
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
