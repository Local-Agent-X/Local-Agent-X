// ── Protocols Page (master/detail editor) ──
// Categories sidebar with search → click protocol → full detail/edit on the right.

let protocolList = [];           // abbreviated records from /api/protocols
let selectedName = null;         // currently-selected protocol name
let selectedRecord = null;       // full record fetched from /api/protocols/:name
let editing = false;             // toggles view ↔ edit
let editDraft = null;            // working copy while editing
let searchQuery = "";

const SOURCE_ORDER = { custom: 0, imported: 1, bundled: 2, builtin: 3 };

function init_protocols() { protocolLoad(); }
if (document.getElementById('page-protocols')?.classList.contains('active')) { protocolLoad(); }

async function protocolLoad() {
  const tree = document.getElementById('protocol-tree');
  if (!tree) return;
  tree.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:.75rem">Loading…</div>';
  try {
    const data = await apiFetch('/api/protocols').then(r => r.json());
    protocolList = Array.isArray(data.protocols) ? data.protocols : [];
    document.getElementById('protocol-count').textContent = `${protocolList.length} protocols`;
    protocolRenderTree();
  } catch (e) {
    tree.innerHTML = `<div style="padding:12px;color:#e88;font-size:.75rem">Failed to load protocols.</div>`;
  }
}

function protocolFilter() {
  searchQuery = (document.getElementById('protocol-search').value || '').trim().toLowerCase();
  protocolRenderTree();
}

function protocolRenderTree() {
  const tree = document.getElementById('protocol-tree');
  const filtered = searchQuery
    ? protocolList.filter(p =>
        p.name.toLowerCase().includes(searchQuery) ||
        (p.description || '').toLowerCase().includes(searchQuery) ||
        (p.tags || []).some(t => String(t).toLowerCase().includes(searchQuery)))
    : protocolList;

  if (filtered.length === 0) {
    tree.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:.75rem">${searchQuery ? 'No matches.' : 'No protocols yet.'}</div>`;
    return;
  }

  // Group by category, sort items by source priority then name.
  const groups = {};
  for (const p of filtered) {
    const cat = p.category || 'General';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(p);
  }
  const catOrder = ['Social Media', 'Communication', 'Developer', 'Research', 'Documents', 'Smart Home', 'General'];
  const cats = catOrder.filter(c => groups[c]).concat(Object.keys(groups).filter(c => !catOrder.includes(c)).sort());

  tree.innerHTML = cats.map(cat => {
    const items = groups[cat].sort((a, b) => {
      const ao = SOURCE_ORDER[a.source?.type] ?? 99;
      const bo = SOURCE_ORDER[b.source?.type] ?? 99;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name);
    });
    return `
      <div class="drill-section-head"><span>${esc(cat)}</span><span class="drill-section-count">${items.length}</span></div>
      <div class="drill-grid">
        ${items.map(p => {
          // Only user-created protocols get a tag. builtin (typed packs)
          // and bundled (SKILL.md vendored in protocols/bundled/) both
          // ship with the app — same tier from the user's perspective —
          // so neither shows a label. imported and custom collapse to a
          // single "custom" tag since the distinction is internal plumbing.
          const stype = p.source?.type;
          const sourceTag = (stype === 'imported' || stype === 'custom')
            ? `<span class="proto-item-source" style="margin-left:auto">custom</span>`
            : '';
          const desc = (p.description || '').slice(0, 110);
          return `<div class="drill-card" onclick="protocolSelect('${esc(p.name)}')" title="${esc(p.description || '')}">
            <div class="drill-card-title">${esc(p.name)}${sourceTag}</div>
            ${desc ? `<div class="drill-card-sub" style="font-family:inherit;line-height:1.35">${esc(desc)}${p.description && p.description.length > 110 ? '…' : ''}</div>` : ''}
          </div>`;
        }).join('')}
      </div>`;
  }).join('');
}

async function protocolSelect(name) {
  selectedName = name;
  editing = false;
  editDraft = null;
  showProtocolsDetail();
  const view = document.getElementById('protocol-view');
  view.innerHTML = '<div style="padding:20px;color:var(--muted);font-size:.8rem">Loading…</div>';
  try {
    const data = await apiFetch(`/api/protocols/${encodeURIComponent(name)}`).then(r => r.json());
    selectedRecord = data.protocol;
    protocolRenderDetail();
  } catch (e) {
    view.innerHTML = `<div style="padding:20px;color:#e88;font-size:.8rem">Failed to load protocol.</div>`;
  }
}

function showProtocolsDetail() {
  document.getElementById('protocols-list-view')?.classList.add('hidden');
  document.getElementById('protocol-detail-wrap')?.classList.add('active');
}

function backToProtocolsList() {
  selectedName = null;
  selectedRecord = null;
  editing = false;
  editDraft = null;
  document.getElementById('protocol-detail-wrap')?.classList.remove('active');
  document.getElementById('protocols-list-view')?.classList.remove('hidden');
}

function protocolRenderDetail() {
  const view = document.getElementById('protocol-view');
  if (!selectedRecord) { backToProtocolsList(); return; }
  const p = selectedRecord;
  const stype = p.source?.type || 'builtin';
  const readOnly = stype === 'builtin' || stype === 'bundled';

  if (editing) { protocolRenderEdit(); return; }

  const sourceLine = (() => {
    const parts = [];
    // Collapse internal source types to the two tiers users care about:
    // built-in (ships with the app) vs custom (user-created or imported).
    const tier = (stype === 'imported' || stype === 'custom') ? 'custom' : 'built-in';
    parts.push(`source: <strong>${esc(tier)}</strong>`);
    if (p.source?.repo) {
      const url = p.source.repo.startsWith('http') ? p.source.repo : `https://github.com/${p.source.repo}`;
      parts.push(`repo: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.source.repo)}</a>`);
    }
    if (p.source?.license) parts.push(`license: ${esc(p.source.license)}`);
    if (p.source?.commit) parts.push(`commit: ${esc(p.source.commit.slice(0, 7))}`);
    if (p.category) parts.push(`category: ${esc(p.category)}`);
    if (Array.isArray(p.tags) && p.tags.length) parts.push(`tags: ${p.tags.map(t => `<span class="proto-tag">${esc(t)}</span>`).join('')}`);
    return parts.join(' &middot; ');
  })();

  const triggers = (p.triggers || []).map(t => `<span class="proto-tag">${esc(t)}</span>`).join('');
  const allowedTools = (p.allowedTools || []).map(t => `<span class="proto-tag">${esc(t)}</span>`).join('');

  // Body or steps render
  let bodyHtml = '';
  if (p.body) {
    bodyHtml = `<div class="proto-section"><h4>Body</h4><div class="proto-body-render">${esc(p.body)}</div></div>`;
  }
  if (Array.isArray(p.steps) && p.steps.length > 0) {
    const stepsRender = p.steps.map((s, i) => `${i + 1}. <strong>${esc(s.id || '')}</strong> — ${esc(s.instruction || '')}`).join('\n');
    bodyHtml += `<div class="proto-section"><h4>Steps</h4><div class="proto-body-render">${esc(stepsRender)}</div></div>`;
  }
  if (Array.isArray(p.rules) && p.rules.length > 0) {
    const rulesRender = p.rules.map((r, i) => `${i + 1}. ${esc(r)}`).join('\n');
    bodyHtml += `<div class="proto-section"><h4>Rules</h4><div class="proto-body-render">${rulesRender}</div></div>`;
  }
  if (!bodyHtml) {
    bodyHtml = `<div class="proto-section"><div class="proto-body-render" style="color:var(--muted)">(no body, no steps — likely a placeholder)</div></div>`;
  }

  view.innerHTML = `
    <h2>${esc(p.name)}</h2>
    <div class="proto-meta">${sourceLine}</div>
    <div class="proto-section">
      <h4>Description</h4>
      <div class="proto-body-render">${esc(p.description || '(no description)')}</div>
    </div>
    ${triggers ? `<div class="proto-section"><h4>Triggers</h4><div>${triggers}</div></div>` : ''}
    ${bodyHtml}
    ${allowedTools ? `<div class="proto-section"><h4>Allowed Tools</h4><div>${allowedTools}</div></div>` : ''}
    <div class="proto-actions">
      <button class="proto-btn" onclick="protocolStartEdit()" ${readOnly ? 'disabled title="Built-in/bundled — fork to mine first"' : ''}>Edit</button>
      <button class="proto-btn" onclick="protocolFork()" ${readOnly ? '' : 'disabled title="Already editable"'}>Fork to mine</button>
      <button class="proto-btn primary" onclick="protocolRun()">Run in chat</button>
      ${!readOnly ? `<button class="proto-btn danger" onclick="protocolDelete()">Delete</button>` : ''}
    </div>
  `;
}

function protocolStartEdit() {
  if (!selectedRecord) return;
  editing = true;
  editDraft = {
    name: selectedRecord.name,
    description: selectedRecord.description || '',
    body: selectedRecord.body || '',
    triggers: (selectedRecord.triggers || []).join(', '),
    category: selectedRecord.category || '',
    tags: (selectedRecord.tags || []).join(', '),
  };
  protocolRenderEdit();
}

function protocolRenderEdit() {
  const view = document.getElementById('protocol-view');
  const isNew = !selectedRecord;
  const d = editDraft;
  view.innerHTML = `
    <h2>${isNew ? 'New Protocol' : esc(d.name)}</h2>
    <div class="proto-section">
      <h4>Name</h4>
      <input class="proto-edit-input" id="edit-name" value="${esc(d.name || '')}" ${isNew ? '' : 'disabled'} placeholder="snake_case_name"/>
    </div>
    <div class="proto-section">
      <h4>Description</h4>
      <input class="proto-edit-input" id="edit-description" value="${esc(d.description)}" placeholder="One-line summary of what this protocol does"/>
    </div>
    <div class="proto-section">
      <h4>Triggers (comma-separated)</h4>
      <input class="proto-edit-input" id="edit-triggers" value="${esc(d.triggers)}" placeholder="post on instagram, share on ig, ig post"/>
    </div>
    <div class="proto-section" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <h4>Category</h4>
        <input class="proto-edit-input" id="edit-category" value="${esc(d.category)}" placeholder="Developer / Research / ..."/>
      </div>
      <div>
        <h4>Tags (comma-separated)</h4>
        <input class="proto-edit-input" id="edit-tags" value="${esc(d.tags)}" placeholder="git, deploy, ci"/>
      </div>
    </div>
    <div class="proto-section">
      <h4>Body (markdown)</h4>
      <textarea class="proto-edit-textarea" id="edit-body" placeholder="# Steps&#10;1. Do this&#10;2. Then this">${esc(d.body)}</textarea>
    </div>
    <div class="proto-actions">
      <button class="proto-btn primary" onclick="protocolSave()">Save</button>
      <button class="proto-btn" onclick="protocolCancelEdit()">Cancel</button>
    </div>
  `;
}

function protocolCancelEdit() {
  editing = false;
  editDraft = null;
  if (selectedRecord) protocolRenderDetail();
  else backToProtocolsList();
}

function protocolStartNew() {
  selectedRecord = null;
  selectedName = null;
  editing = true;
  editDraft = { name: '', description: '', body: '', triggers: '', category: '', tags: '' };
  showProtocolsDetail();
  protocolRenderEdit();
}

async function protocolSave() {
  const name = (document.getElementById('edit-name').value || '').trim();
  const description = (document.getElementById('edit-description').value || '').trim();
  const body = document.getElementById('edit-body').value;
  const triggers = (document.getElementById('edit-triggers').value || '').split(',').map(t => t.trim()).filter(Boolean);
  const category = (document.getElementById('edit-category').value || '').trim() || undefined;
  const tags = (document.getElementById('edit-tags').value || '').split(',').map(t => t.trim()).filter(Boolean);

  if (!name) { alert('Name is required.'); return; }

  try {
    const isNew = !selectedRecord;
    const url = isNew ? '/api/protocols' : `/api/protocols/${encodeURIComponent(selectedRecord.name)}`;
    const method = isNew ? 'POST' : 'PATCH';
    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, body, triggers, category, tags }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || `Save failed (${res.status})`);
      return;
    }
    editing = false;
    editDraft = null;
    await protocolLoad();
    selectedName = name;
    await protocolSelect(name);
  } catch (e) {
    alert(`Save failed: ${e.message || e}`);
  }
}

async function protocolFork() {
  if (!selectedRecord) return;
  const newName = prompt('Fork to a new name (leave blank to use "<name>_mine"):', '');
  try {
    const res = await apiFetch(`/api/protocols/${encodeURIComponent(selectedRecord.name)}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newName ? { newName } : {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || `Fork failed (${res.status})`);
      return;
    }
    const data = await res.json();
    await protocolLoad();
    selectedName = data.protocol.name;
    await protocolSelect(data.protocol.name);
    protocolStartEdit();
  } catch (e) {
    alert(`Fork failed: ${e.message || e}`);
  }
}

async function protocolDelete() {
  if (!selectedRecord) return;
  if (!confirm(`Delete protocol "${selectedRecord.name}"? This is irreversible.`)) return;
  try {
    const res = await apiFetch(`/api/protocols/${encodeURIComponent(selectedRecord.name)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || `Delete failed (${res.status})`);
      return;
    }
    backToProtocolsList();
    await protocolLoad();
  } catch (e) {
    alert(`Delete failed: ${e.message || e}`);
  }
}

function protocolRun() {
  if (!selectedRecord) return;
  const trigger = (selectedRecord.triggers && selectedRecord.triggers[0]) || selectedRecord.name;
  navigate('chat');
  const input = document.getElementById('msg-input');
  if (input) { input.value = trigger; input.focus(); }
}

function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
