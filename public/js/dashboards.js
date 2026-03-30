// ── Dashboards Gallery ──

async function init_dashboards() {
  await loadDashboards();
  await loadCustomPages();
}

async function loadDashboards() {
  const grid = document.getElementById('dashboards-grid');
  const empty = document.getElementById('dashboards-empty');
  if (!grid) return;

  try {
    const r = await fetch(`${API}/api/dashboards`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const dashboards = await r.json();

    if (!Array.isArray(dashboards) || dashboards.length === 0) {
      grid.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }

    if (empty) empty.style.display = 'none';
    grid.innerHTML = dashboards.map(d => `
      <div class="dash-card" onclick="window.open('/dashboards/${d.id}','_blank')">
        <div class="dash-card-header">
          <span class="dash-card-name">${esc(d.name)}</span>
          <span class="dash-card-layout">${esc(d.layout)}</span>
        </div>
        <div class="dash-card-desc">${esc(d.description || 'No description')}</div>
        <div class="dash-card-footer">
          <span>${d.components} component${d.components !== 1 ? 's' : ''}</span>
          <span>${timeAgo(d.updatedAt)}</span>
        </div>
        <div class="dash-card-actions" onclick="event.stopPropagation()">
          <button class="dash-action-btn" onclick="openDashboard('${d.id}')" title="Open">Open</button>
          <button class="dash-action-btn danger" onclick="deleteDashboard('${d.id}','${esc(d.name)}')" title="Delete">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    grid.innerHTML = '<p style="color:var(--muted)">Failed to load dashboards</p>';
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
      <div class="dash-card small" onclick="window.open('/${p.name}.html','_blank')">
        <div class="dash-card-name">${esc(p.title || p.name)}</div>
        <div class="dash-card-footer">
          <span>/${p.name}.html</span>
          <button class="dash-action-btn danger" onclick="event.stopPropagation();deleteCustomPage('${p.name}')" title="Delete">X</button>
        </div>
      </div>
    `).join('');
  } catch {
    section.style.display = 'none';
  }
}

function openDashboard(id) {
  window.open('/dashboards/' + id, '_blank');
}

async function deleteDashboard(id, name) {
  if (!confirm('Delete dashboard "' + name + '"?')) return;
  try {
    await fetch(`${API}/api/dashboards/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    loadDashboards();
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

function promptCreateDashboard() {
  // Navigate to chat and pre-fill a message about creating a dashboard
  navigate('chat');
  const input = document.getElementById('message-input');
  if (input) {
    input.value = 'Create a dashboard for me: ';
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

// ── Auto-refresh dashboards gallery on changes ──
// Uses polling instead of WS monkey-patching to avoid breaking agent feed hooks

let _dashLastCheck = 0;
function pollDashboardChanges() {
  const page = document.getElementById('page-dashboards');
  if (!page || !page.classList.contains('active')) return;
  // Refresh every 5 seconds when viewing dashboards page
  const now = Date.now();
  if (now - _dashLastCheck < 5000) return;
  _dashLastCheck = now;
  loadDashboards();
  loadCustomPages();
}

setInterval(pollDashboardChanges, 5000);

// Auto-load when navigated to
window.init_dashboards = init_dashboards;
