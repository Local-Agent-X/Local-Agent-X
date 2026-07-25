// ── Protocols Page: archived view ──
// The recoverable half of delete. A protocol removed without ?permanent=true is
// soft-archived, and this view is where the user finds it again — which is the
// entire safety story for protocols the agent authored on its own initiative,
// since no confirmation gate precedes those writes.
//
// Split out of protocols.js to stay under the 400-LOC source-hygiene gate.
// MUST load BEFORE protocols.js: that file calls protocolLoadArchived() at load
// time, and reads archivedList/viewMode declared here (a `let` in a classic
// script is shared across scripts but is in TDZ until its own script runs).
// Calls escAttr/protocolSourceTag from protocols-provenance.js, which loads
// before both — function declarations, so only call order matters, not load
// order, but app.html keeps the order honest anyway.

let archivedList = [];           // abbreviated records from /api/protocols/archived
let viewMode = 'live';           // 'live' | 'archived'

async function protocolLoadArchived() {
  try { const d = await apiFetch('/api/protocols/archived').then(r => r.json()); archivedList = Array.isArray(d.archived) ? d.archived : []; } catch (e) { archivedList = []; }
}

function protocolToggleArchived() { viewMode = viewMode === 'archived' ? 'live' : 'archived'; protocolRenderTree(); }

// Called from protocolRenderTree so one render path owns the toggle's state.
function protocolSyncArchivedToggle() {
  const toggle = document.getElementById('protocol-archived-toggle');
  if (!toggle) return;
  toggle.textContent = viewMode === 'archived' ? '← Active' : `Archived (${archivedList.length})`;
  toggle.disabled = viewMode === 'live' && archivedList.length === 0;
}

function protocolRenderArchived() {
  const tree = document.getElementById('protocol-tree');
  const items = archivedList.filter(r => !searchQuery || r.name.toLowerCase().includes(searchQuery) || (r.description || '').toLowerCase().includes(searchQuery))
    .sort((a, b) => (b.archivedTs || 0) - (a.archivedTs || 0));
  const empty = searchQuery ? 'No archived matches.' : 'Nothing archived. Archived protocols wait here until you restore them.';
  if (items.length === 0) { tree.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:.75rem">${empty}</div>`; return; }
  // Restore rides in a data-* attribute, not an onclick — see protocolTreeClick.
  tree.innerHTML = `
    <div class="drill-section-head"><span>Archived</span><span class="drill-section-count">${items.length}</span></div>
    <div class="drill-grid">
      ${items.map(r => `<div class="drill-card">
        <div class="drill-card-title">${esc(r.name)}${protocolSourceTag(r)}</div>
        <div class="drill-card-sub" style="font-family:inherit;line-height:1.35">${esc((r.description || '').slice(0, 110))}</div>
        <div style="color:var(--muted);font-size:.68rem;margin:6px 0 8px">archived ${esc(r.archivedTs ? new Date(r.archivedTs).toLocaleDateString() : 'unknown date')}${r.reason ? ` · ${esc(r.reason)}` : ''}</div>
        <button class="proto-btn" data-proto-restore="${escAttr(r.name)}">Restore</button>
      </div>`).join('')}
    </div>`;
}

// Optimistic remove + rollback, matching public/js/settings-learned-workflows.js.
async function protocolRestore(name) {
  const previous = archivedList.slice();
  archivedList = archivedList.filter(r => r.name !== name); protocolRenderTree();
  try {
    const res = await apiFetch(`/api/protocols/${encodeURIComponent(name)}/unarchive`, { method: 'POST' });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `Restore failed (${res.status})`); }
    await protocolLoad();
  } catch (e) {
    archivedList = previous; protocolRenderTree();
    alert(`Restore failed: ${e.message || e}`);
  }
}
