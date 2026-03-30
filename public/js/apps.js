// ── Apps Gallery ──
// Enterprise app management UI with status indicators, permissions, and inline controls

async function init_apps() {
  await loadApps();
  await loadCustomPages();
}

async function loadApps() {
  const grid = document.getElementById('apps-grid');
  const empty = document.getElementById('apps-empty');
  if (!grid) return;

  try {
    const r = await fetch(`${API}/api/apps`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const apps = await r.json();

    if (!Array.isArray(apps) || apps.length === 0) {
      grid.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }

    if (empty) empty.style.display = 'none';
    grid.innerHTML = apps.map(a => {
      const statusClass = a.status !== 'active' ? ` app-card-${esc(a.status)}` : '';
      const statusBadge = a.status !== 'active'
        ? `<span class="app-card-status app-card-status-${esc(a.status)}">${esc(a.status)}</span>`
        : '';
      const visibilityIcon = a.visibility === 'private' ? '&#128274;' : a.visibility === 'public' ? '&#127760;' : '&#128101;';

      return `
      <div class="app-card${statusClass}" onclick="openApp('${esc(a.id)}')">
        <div class="app-card-header">
          <span class="app-card-name">${esc(a.name)}</span>
          <div style="display:flex;gap:6px;align-items:center">
            ${statusBadge}
            <span class="app-card-layout">${esc(a.layout)}</span>
          </div>
        </div>
        <div class="app-card-desc">${esc(a.description || 'No description')}</div>
        <div class="app-card-footer">
          <span>${a.components} component${a.components !== 1 ? 's' : ''} &middot; v${a.version || 1}</span>
          <span title="${esc(a.visibility || 'team')}">${visibilityIcon} ${timeAgo(a.updatedAt)}</span>
        </div>
        <div class="app-card-actions" onclick="event.stopPropagation()">
          <button class="app-action-btn" onclick="openApp('${esc(a.id)}')" title="Open in new tab">Open</button>
          <button class="app-action-btn" onclick="exportApp('${esc(a.id)}','${esc(a.name)}')" title="Export as standalone HTML">Export</button>
          ${a.status === 'active'
            ? `<button class="app-action-btn" onclick="suspendApp('${esc(a.id)}','${esc(a.name)}')" title="Suspend app">Suspend</button>`
            : a.status === 'suspended'
              ? `<button class="app-action-btn" onclick="activateApp('${esc(a.id)}')" title="Reactivate app">Activate</button>`
              : ''}
          <button class="app-action-btn danger" onclick="deleteApp('${esc(a.id)}','${esc(a.name)}')" title="Delete">Delete</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    grid.innerHTML = '<p style="color:var(--muted)">Failed to load apps</p>';
  }
}

async function loadCustomPages() {
  const section = document.getElementById('custom-pages-section');
  const list = document.getElementById('custom-pages-list');
  if (!section || !list) return;

  try {
    const r = await fetch(`${API}/api/custom-pages`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const pages = await r.json();

    if (!Array.isArray(pages) || pages.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';
    list.innerHTML = pages.map(p => `
      <div class="app-card small" onclick="window.open('/${p.name}.html','_blank')">
        <div class="app-card-name">${esc(p.title || p.name)}</div>
        <div class="app-card-footer">
          <span>/${p.name}.html</span>
          <button class="app-action-btn danger" onclick="event.stopPropagation();deleteCustomPage('${p.name}')" title="Delete">X</button>
        </div>
      </div>
    `).join('');
  } catch {
    section.style.display = 'none';
  }
}

function openApp(id) {
  window.open('/apps/' + id, '_blank');
}

async function deleteApp(id, name) {
  if (!confirm('Delete app "' + name + '"? This removes all state, events, and audit logs.')) return;
  try {
    await fetch(`${API}/api/apps/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    loadApps();
  } catch {}
}

async function suspendApp(id, name) {
  if (!confirm('Suspend app "' + name + '"? Agents will lose access until reactivated.')) return;
  try {
    await fetch(`${API}/api/apps/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ status: 'suspended' })
    });
    loadApps();
  } catch {}
}

async function activateApp(id) {
  try {
    await fetch(`${API}/api/apps/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ status: 'active' })
    });
    loadApps();
  } catch {}
}

async function deleteCustomPage(name) {
  if (!confirm('Delete page "' + name + '"?')) return;
  try {
    await fetch(`${API}/api/custom-pages/${name}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    loadCustomPages();
  } catch {}
}

async function exportApp(id, name) {
  try {
    // Fetch the rendered HTML
    const r = await fetch(`${API}/apps/${id}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    if (!r.ok) throw new Error('Failed to fetch app');
    let html = await r.text();

    // Make it standalone: replace API polling with static state
    // Remove the polling script's API dependency so it works offline
    html = html.replace(
      /var API = [^;]+;/,
      'var API = ""; // Exported - no live connection'
    );

    // Download as HTML file
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (name || id) + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export failed: ' + e.message);
  }
}

function promptCreateApp() {
  navigate('chat');
  const input = document.getElementById('message-input');
  if (input) {
    input.value = 'Create an app for me: ';
    input.focus();
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

// ── Auto-refresh apps gallery ──
let _appsLastCheck = 0;
function pollAppChanges() {
  const page = document.getElementById('page-apps');
  if (!page || !page.classList.contains('active')) return;
  const now = Date.now();
  if (now - _appsLastCheck < 5000) return;
  _appsLastCheck = now;
  loadApps();
  loadCustomPages();
}

setInterval(pollAppChanges, 5000);

window.init_apps = init_apps;
