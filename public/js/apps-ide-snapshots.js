// IDE topbar ↺ Revert dropdown. Reads per-turn snapshots from the
// backend (~/.lax/app-snapshots/<appId>/) and restores the picked turn's
// files on click. The snapshot is taken automatically at the end of any
// turn that wrote/edited a file under workspace/apps/<appId>/.

function ideRevertMenuEl() { return document.getElementById('ide-revert-menu'); }
function ideRevertBtnEl()  { return document.getElementById('ide-revert-btn'); }

function _ideFmtAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hr ago';
  const d = Math.floor(h / 24);
  return d + ' d ago';
}

function _ideRenderRevertMenu(items) {
  const menu = ideRevertMenuEl();
  if (!menu) return;
  if (!items || items.length === 0) {
    menu.innerHTML = '<div class="ide-revert-empty">No snapshots yet — edits in this IDE will appear here.</div>';
    return;
  }
  menu.innerHTML = items.map(s => {
    const filesPreview = (s.files || []).slice(0, 3).join(', ') + ((s.files || []).length > 3 ? ` +${s.files.length - 3}` : '');
    return `<div class="ide-revert-item" onclick="ideRevertSnapshot(${s.turnIdx}, ${s.ts})" title="Restore the files this turn touched">
      <div class="ide-revert-item-head">Turn ${s.turnIdx} <span class="ide-revert-ago">${_ideFmtAgo(s.ts)}</span></div>
      <div class="ide-revert-item-files">${filesPreview ? 'edited ' + filesPreview : 'no files recorded'}</div>
    </div>`;
  }).join('');
}

async function ideRefreshSnapshots() {
  if (typeof _ideAppId === 'undefined' || !_ideAppId) return;
  try {
    const r = await fetch(`${API}/api/apps/${_ideAppId}/snapshots`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    if (!r.ok) { _ideRenderRevertMenu([]); return; }
    const items = await r.json();
    _ideRenderRevertMenu(Array.isArray(items) ? items : []);
  } catch {
    _ideRenderRevertMenu([]);
  }
}

function ideToggleRevertMenu() {
  const menu = ideRevertMenuEl();
  if (!menu) return;
  const isOpen = menu.style.display !== 'none';
  if (isOpen) {
    menu.style.display = 'none';
    return;
  }
  // Refresh on open — cheap, always up to date with whatever the agent
  // just did. Avoids subscribing to a turn-completed event from this
  // file (the WS handler lives in apps-ide-ws.js and is already busy).
  menu.style.display = 'block';
  ideRefreshSnapshots();
}

async function ideRevertSnapshot(turnIdx, ts) {
  if (typeof _ideAppId === 'undefined' || !_ideAppId) return;
  if (!confirm(`Restore app files to turn ${turnIdx}? Files edited in later turns will be overwritten with the snapshot.`)) return;
  try {
    const r = await fetch(`${API}/api/apps/${_ideAppId}/revert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({ turnIdx, ts }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || out.ok === false) {
      alert('Revert failed: ' + (out.error || (out.errors && out.errors.join('; ')) || 'unknown error'));
      return;
    }
    const menu = ideRevertMenuEl();
    if (menu) menu.style.display = 'none';
    if (typeof ideRefreshPreview === 'function') ideRefreshPreview();
    if (typeof ideLoadFiles === 'function') ideLoadFiles();
    if (typeof ideSetStatus === 'function') {
      ideSetStatus('done', `Reverted to turn ${turnIdx} (${(out.restored || []).length} file${(out.restored || []).length === 1 ? '' : 's'})`);
    }
  } catch (e) {
    alert('Revert failed: ' + (e && e.message ? e.message : 'network error'));
  }
}

// Click-outside to close.
document.addEventListener('click', (e) => {
  const menu = ideRevertMenuEl();
  const btn  = ideRevertBtnEl();
  if (!menu || menu.style.display === 'none') return;
  if (e.target === btn || (btn && btn.contains(e.target))) return;
  if (menu.contains(e.target)) return;
  menu.style.display = 'none';
});

window.ideToggleRevertMenu = ideToggleRevertMenu;
window.ideRefreshSnapshots = ideRefreshSnapshots;
window.ideRevertSnapshot   = ideRevertSnapshot;
