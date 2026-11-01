// Settings: Rollback — list recent file captures (src/autonomy/rollback.ts), undo on click.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function rollbackArtifactSummary(artifacts) {
  const useful = artifacts.filter(a => a.type !== 'none');
  if (useful.length === 0) {
    const reason = (artifacts.find(a => a.type === 'none') || {}).reason || 'no capture';
    return `<span style="color:var(--muted)">${escapeHtml(reason)}</span>`;
  }
  return useful.map(a => {
    if (a.type === 'file-backup') return `file: ${escapeHtml(a.original)}`;
    if (a.type === 'created') return `new file: ${escapeHtml(a.original)}`;
    return escapeHtml(a.type);
  }).join(', ');
}

async function undoRollback(toolCallId, btn) {
  if (!confirm(`Undo ${toolCallId}? Its files go back to how they were before it; files it created go to the trash.`)) return;
  btn.disabled = true; btn.textContent = '...';
  try {
    const r = await apiFetch('/api/rollback/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId })
    });
    const d = await r.json();
    if (r.ok) {
      btn.textContent = 'Undone';
      setTimeout(loadRollbackList, 800);
    } else {
      btn.disabled = false; btn.textContent = 'Undo';
      alert('Undo failed: ' + (d.error || 'unknown'));
    }
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Undo';
    alert('Undo failed: ' + e.message);
  }
}

async function loadRollbackList() {
  const host = document.getElementById('rollback-list');
  if (!host) return;
  host.textContent = 'Loading...';
  try {
    const res = await apiFetch('/api/rollback/list?limit=20');
    if (!res.ok) { host.textContent = 'Could not load rollback list.'; return; }
    const { entries } = await res.json();
    if (!entries || entries.length === 0) {
      host.innerHTML = '<span style="color:var(--muted)">Nothing yet. Every file the agent writes, edits or deletes with its file tools shows up here.</span>';
      return;
    }
    host.innerHTML = entries.map((e) => {
      const when = new Date(e.ts).toLocaleString();
      const summary = rollbackArtifactSummary(e.artifacts);
      const button = e.restored
        ? '<span style="color:var(--muted);font-size:.7rem">restored</span>'
        : `<button class="action-btn" style="font-size:.7rem;padding:3px 10px" onclick="undoRollback('${escapeHtml(e.toolCallId)}', this)">Undo</button>`;
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--mono);font-size:.72rem;color:var(--muted)">${escapeHtml(e.toolCallId)} · ${escapeHtml(when)}</div>
          <div><strong>${escapeHtml(e.tool)}</strong></div>
          <div style="font-size:.72rem;color:var(--muted)">${summary}</div>
        </div>
        <div>${button}</div>
      </div>`;
    }).join('');
  } catch (e) {
    host.textContent = 'Could not load rollback list: ' + e.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Lazy-load when the section becomes visible at least once.
  if (document.getElementById('rollback-list')) loadRollbackList();
});
