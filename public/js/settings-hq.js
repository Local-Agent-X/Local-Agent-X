// ── HQ tab — app identity, updates, decommission ──
// The update check/apply logic lives in app.js + settings.js (shared with the
// boot banner); this file only owns what is unique to the HQ tab.

async function hqLoad() {
  const versionEl = document.getElementById('hq-version');
  const commitEl = document.getElementById('hq-commit');
  try {
    const data = await apiFetch('/api/health').then(r => r.json());
    if (versionEl) versionEl.textContent = 'Version ' + (data.version || '?');
  } catch (e) {
    if (versionEl) versionEl.textContent = 'Version unavailable';
  }
  try {
    const u = window._laxServerUpdate || await apiFetch('/api/updates/check').then(r => r.json());
    if (commitEl && u && u.localCommit) {
      commitEl.textContent = (u.rolling ? 'Rolling' : 'Branch main') + ' · commit ' + u.localCommit;
    }
  } catch (e) { /* commit line is cosmetic */ }
  // Refresh the shared update-status card whenever the tab opens.
  if (typeof laxCheckUpdates === 'function') void laxCheckUpdates(false);
}

async function hqDecommissionPreview() {
  const pre = document.getElementById('hq-decommission-preview');
  if (!pre) return;
  pre.style.display = '';
  pre.textContent = 'Running dry run…';
  try {
    const res = await apiFetch('/api/decommission/plan');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { pre.textContent = 'Preview failed: ' + (data.error || res.status); return; }
    pre.textContent = (data.report || '(empty report)') + '\n\n[script: ' + data.script + ']';
  } catch (e) {
    pre.textContent = 'Preview failed: ' + (e && e.message ? e.message : String(e));
  }
}

async function hqDecommission(deleteData) {
  const status = document.getElementById('hq-decommission-status');
  if (deleteData) {
    // Electron 20+ disabled window.prompt() — it returns null instantly, so the
    // old prompt-based confirm made the "Decommission everything" button
    // silently do nothing. Use a custom modal (declared in app.html) instead.
    const modal = document.getElementById('hq-decommission-modal');
    const input = document.getElementById('hq-decommission-input');
    if (!modal || !input) {
      // Fallback for anyone running the page outside the packaged HTML
      const typed = window.prompt && window.prompt('Type DECOMMISSION to confirm:');
      if (typed !== 'DECOMMISSION') return;
    } else {
      input.value = '';
      const confirmBtn = document.getElementById('hq-decommission-modal-confirm');
      if (confirmBtn) confirmBtn.disabled = true;
      modal.style.display = 'flex';
      setTimeout(() => input.focus(), 20);
      // The rest of this function is driven by the modal — hqDecommissionModalConfirm()
      // calls hqDecommissionRun(true) when the user types DECOMMISSION and hits go.
      window._hqPendingDecommission = true;
      return;
    }
  } else {
    if (!confirm('Remove Local Agent X from this machine? Your data stays in ~/.lax for a future reinstall. The app will close to finish the job.')) return;
  }
  hqDecommissionRun(deleteData);
}

function hqDecommissionModalOnInput() {
  const input = document.getElementById('hq-decommission-input');
  const btn = document.getElementById('hq-decommission-modal-confirm');
  if (!input || !btn) return;
  btn.disabled = input.value.trim() !== 'DECOMMISSION';
}

function hqDecommissionModalCancel() {
  const modal = document.getElementById('hq-decommission-modal');
  if (modal) modal.style.display = 'none';
  window._hqPendingDecommission = false;
}

function hqDecommissionModalConfirm() {
  const input = document.getElementById('hq-decommission-input');
  if (!input || input.value.trim() !== 'DECOMMISSION') return;
  const modal = document.getElementById('hq-decommission-modal');
  if (modal) modal.style.display = 'none';
  window._hqPendingDecommission = false;
  hqDecommissionRun(true);
}

async function hqDecommissionRun(deleteData) {
  const status = document.getElementById('hq-decommission-status');
  if (status) {
    status.style.display = '';
    status.style.color = 'var(--muted)';
    status.textContent = 'Launching the uninstaller…';
  }
  try {
    const res = await apiFetch('/api/decommission/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteData: !!deleteData, confirm: 'DECOMMISSION' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      if (status) { status.style.color = 'var(--error, red)'; status.textContent = 'Could not start the uninstaller: ' + (data.error || res.status); }
      return;
    }
    if (status) {
      status.style.color = 'var(--accent)';
      status.textContent = 'Uninstaller launched — Local Agent X will close in a moment. ' + (deleteData ? 'Goodbye!' : 'Your data is kept for a future reinstall. o7');
    }
  } catch (e) {
    // A dropped connection here usually means the uninstaller already stopped
    // the server — that is success, not failure.
    if (status) {
      status.style.color = 'var(--accent)';
      status.textContent = 'The app is shutting down — the uninstaller has taken over.';
    }
  }
}
