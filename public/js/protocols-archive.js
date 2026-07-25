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
  // The attribute carries "<archivedTs>:<name>", not the bare name, because the
  // archive is VERSIONED: several cards can share a name and only archivedTs
  // tells them apart, so a name alone always resolves to the newest and silently
  // restores a version the user did not click. The delegated listener in
  // protocols.js passes this value through verbatim; parsing is owned here.
  // archivedTs is rendered as a decimal integer, so the FIRST ':' is always the
  // delimiter even for a name full of colons.
  tree.innerHTML = `
    <div class="drill-section-head"><span>Archived</span><span class="drill-section-count">${items.length}</span></div>
    <div class="drill-grid">
      ${items.map(r => `<div class="drill-card">
        <div class="drill-card-title">${esc(r.name)}${protocolSourceTag(r)}</div>
        <div class="drill-card-sub" style="font-family:inherit;line-height:1.35">${esc((r.description || '').slice(0, 110))}</div>
        <div style="color:var(--muted);font-size:.68rem;margin:6px 0 8px">archived ${esc(r.archivedTs ? new Date(r.archivedTs).toLocaleString() : 'unknown date')}${r.reason ? ` · ${esc(r.reason)}` : ''}</div>
        <button class="proto-btn" data-proto-restore="${escAttr(protocolRestoreToken(r))}">Restore</button>
      </div>`).join('')}
    </div>`;
}

/** "<archivedTs>:<name>" — the value carried by data-proto-restore. */
function protocolRestoreToken(r) {
  return `${Number.isFinite(r.archivedTs) ? r.archivedTs : ''}:${r.name}`;
}

/** Inverse of protocolRestoreToken. A token with no ':' (or an unparseable
 *  stamp) degrades to name-only, i.e. the newest version — the pre-versioning
 *  behaviour, so a malformed record still restores something rather than
 *  nothing. */
function protocolParseRestoreToken(token) {
  const s = String(token ?? '');
  const i = s.indexOf(':');
  if (i === -1) return { name: s, archivedTs: undefined };
  const ts = Number(s.slice(0, i));
  return { name: s.slice(i + 1), archivedTs: Number.isFinite(ts) && s.slice(0, i) !== '' ? ts : undefined };
}

/** The archived record a restore should act on. With no stamp, the newest for
 *  that name — matching unarchiveProtocol()'s own default, so the row the UI
 *  drops is the row the server restores. */
function protocolFindArchived(name, archivedTs) {
  const matches = archivedList.filter(r => r.name === name);
  if (matches.length === 0) return null;
  if (archivedTs === undefined) {
    return matches.reduce((a, b) => ((b.archivedTs || 0) >= (a.archivedTs || 0) ? b : a));
  }
  return matches.find(r => r.archivedTs === archivedTs) || null;
}

// Optimistic remove + rollback, matching public/js/settings-learned-workflows.js.
// Takes the data-proto-restore token, not a bare name.
async function protocolRestore(token) {
  const { name, archivedTs } = protocolParseRestoreToken(token);
  const target = protocolFindArchived(name, archivedTs);
  const previous = archivedList.slice();
  // Drop exactly the record being restored. Filtering by name removed every
  // version of it, so restoring one card made its siblings vanish from the view
  // until a refetch — they are still archived, and the archive is the only place
  // agent-authored work can be recovered from.
  archivedList = target ? archivedList.filter(r => r !== target) : archivedList.filter(r => r.name !== name);
  protocolRenderTree();
  try {
    const ts = target ? target.archivedTs : archivedTs;
    const q = Number.isFinite(ts) ? `?archivedTs=${encodeURIComponent(ts)}` : '';
    const res = await apiFetch(`/api/protocols/${encodeURIComponent(name)}/unarchive${q}`, { method: 'POST' });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `Restore failed (${res.status})`); }
    await protocolLoad();
  } catch (e) {
    archivedList = previous; protocolRenderTree();
    alert(`Restore failed: ${e.message || e}`);
  }
}
