// IDE topbar ↺ Revert dropdown. Reads per-turn snapshots from the
// backend (~/.lax/app-snapshots/<appId>/) and restores the picked turn's
// files on click. The snapshot is taken automatically at the end of any
// turn that wrote/edited a file under workspace/apps/<appId>/.

function ideRevertMenuEl()  { return document.getElementById('ide-revert-menu'); }
function ideRevertBtnEl()   { return document.getElementById('ide-revert-btn'); }
function ideForwardBtnEl()  { return document.getElementById('ide-forward-btn'); }

// Cursor: which turnIdx we're currently AT, or null = at the latest snapshot.
// Set by ideRevertSnapshot; advanced by ideForwardSnapshot; cleared when a
// new turn lands (snapshot list grows past where we were).
let _ideSnapshotCursor = null;
// Last seen items list — cached so Forward doesn't have to re-fetch.
let _ideSnapshotItems = [];

function _ideUpdateForwardBtn() {
  const btn = ideForwardBtnEl();
  if (!btn) return;
  if (_ideSnapshotCursor === null) btn.setAttribute('disabled', '');
  else btn.removeAttribute('disabled');
}

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
    if (!r.ok) { _ideSnapshotItems = []; _ideRenderRevertMenu([]); return; }
    const items = await r.json();
    _ideSnapshotItems = Array.isArray(items) ? items : [];
    // If a new turn snapshot landed after we were holding a cursor, the
    // user has implicitly accepted a new "latest" — clear the cursor so
    // Forward goes back to disabled.
    if (_ideSnapshotCursor !== null && _ideSnapshotItems.length > 0
        && _ideSnapshotItems[0].turnIdx > _ideSnapshotCursor) {
      _ideSnapshotCursor = null;
    }
    _ideUpdateForwardBtn();
    _ideRenderRevertMenu(_ideSnapshotItems);
  } catch {
    _ideSnapshotItems = [];
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
  if (!confirm(`Restore app files to turn ${turnIdx}? Files edited in later turns will be overwritten with the snapshot.`)) return;
  const menu = ideRevertMenuEl();
  if (menu) menu.style.display = 'none';
  await _ideDoRestore(turnIdx, ts, /* newCursor */ turnIdx, /* statusVerb */ 'Reverted');
}

// Step forward toward the most recent snapshot. Disabled until a revert
// sets a cursor. At the newest snapshot, cursor clears so the button
// re-disables.
async function ideForwardSnapshot() {
  if (typeof _ideAppId === 'undefined' || !_ideAppId) return;
  if (_ideSnapshotCursor === null) return;
  // Make sure the cached list is fresh before deciding "next-newer".
  await ideRefreshSnapshots();
  if (_ideSnapshotItems.length === 0 || _ideSnapshotCursor === null) return;
  // Items are newest-first. The "next-newer" turn is the one with the
  // smallest turnIdx that's still > cursor.
  let next = null;
  for (const s of _ideSnapshotItems) {
    if (s.turnIdx > _ideSnapshotCursor && (!next || s.turnIdx < next.turnIdx)) next = s;
  }
  if (!next) return;
  // If we're stepping to the absolute newest, clear the cursor afterwards
  // so the button disables — we're "back at HEAD".
  const isLatest = next.turnIdx === _ideSnapshotItems[0].turnIdx;
  await _ideDoRestore(next.turnIdx, next.ts, isLatest ? null : next.turnIdx, 'Forward to');
}

async function _ideDoRestore(turnIdx, ts, newCursor, statusVerb) {
  if (typeof _ideAppId === 'undefined' || !_ideAppId) return;
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
      alert('Restore failed: ' + (out.error || (out.errors && out.errors.join('; ')) || 'unknown error'));
      return;
    }
    _ideSnapshotCursor = newCursor;
    _ideUpdateForwardBtn();
    if (typeof ideRefreshPreview === 'function') ideRefreshPreview();
    if (typeof ideLoadFiles === 'function') ideLoadFiles();
    if (typeof ideSetStatus === 'function') {
      const n = (out.restored || []).length;
      ideSetStatus('done', `${statusVerb} turn ${turnIdx} (${n} file${n === 1 ? '' : 's'})`);
    }
  } catch (e) {
    alert('Restore failed: ' + (e && e.message ? e.message : 'network error'));
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
window.ideForwardSnapshot  = ideForwardSnapshot;
