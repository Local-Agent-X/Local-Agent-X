// ── Apps Gallery ──
// Enterprise app management UI with status indicators, permissions, and inline controls

const APPS_PROVIDERS = [
  { value: 'xai', label: 'xAI Grok' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'codex', label: 'OpenAI Codex' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'openai', label: 'OpenAI API' },
  { value: 'local', label: 'Local (Ollama)' },
  { value: 'custom', label: 'Custom' },
];

const APPS_MODELS = {
  codex: ['gpt-5.5','gpt-5.4','gpt-5.4-mini','gpt-5.3-codex'],
  anthropic: ['claude-opus-4-7','claude-sonnet-4-6','claude-opus-4-6','claude-haiku-4-5','claude-sonnet-4-5','claude-opus-4-5'],
  xai: ['grok-4','grok-3-mini','grok-3'],
  openai: ['gpt-5.5-pro','gpt-5.5','gpt-4o','gpt-4o-mini','gpt-4.1','gpt-4.1-mini','o3','o4-mini'],
  gemini: ['gemini-2.0-flash','gemini-2.5-pro-preview-05-06','gemini-2.5-flash-preview-05-20','gemini-1.5-pro'],
};

async function init_apps() {
  initAppsModelSelector();
  await loadApps();
  await loadCustomPages();
}

async function initAppsModelSelector() {
  const provSel = document.getElementById('apps-provider-select');
  const modelSel = document.getElementById('apps-model-select');
  if (!provSel || !modelSel) return;

  // Populate providers
  provSel.innerHTML = APPS_PROVIDERS.map(p => `<option value="${p.value}">${p.label}</option>`).join('');

  // Load current settings from server
  try {
    const r = await apiFetch('/api/settings');
    const s = await r.json();
    if (s.provider) provSel.value = s.provider;
    populateAppsModels(s.provider || provSel.value, s.model);
  } catch {
    populateAppsModels(provSel.value);
  }
}

function populateAppsModels(provider, currentModel) {
  const modelSel = document.getElementById('apps-model-select');
  if (!modelSel) return;
  const models = APPS_MODELS[provider] || [];
  if (models.length) {
    modelSel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
    modelSel.style.display = '';
    if (currentModel && models.includes(currentModel)) modelSel.value = currentModel;
  } else {
    modelSel.innerHTML = '<option value="">default</option>';
    modelSel.style.display = provider === 'local' ? 'none' : '';
  }
}

function onAppsProviderChange(provider) {
  populateAppsModels(provider);
  // Save to server
  const model = document.getElementById('apps-model-select')?.value || '';
  apiPost('/api/settings', { provider, model }).catch(() => {});
  // Sync settings page dropdowns if they exist
  const cfgProv = document.getElementById('cfg-provider');
  if (cfgProv) { cfgProv.value = provider; if (typeof onProviderChange === 'function') onProviderChange(provider); }
}

function onAppsModelChange(model) {
  const provider = document.getElementById('apps-provider-select')?.value;
  apiPost('/api/settings', { provider, model }).catch(() => {});
  // Sync settings page model if it exists
  const cfgModel = document.getElementById('cfg-model');
  if (cfgModel) cfgModel.value = model;
}

// Cache-key for the last-rendered apps list. Only re-render when data
// actually changed — otherwise the 5-second poll wipes and rebuilds the
// entire grid (including re-triggering the stagger-in animation), causing
// visible flicker every poll interval.
let _appsRenderKey = "";

async function loadApps() {
  const grid = document.getElementById('apps-grid');
  const empty = document.getElementById('apps-empty');
  if (!grid) return;

  try {
    const r = await fetch(`${API}/api/apps`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const apps = await r.json();

    if (!Array.isArray(apps) || apps.length === 0) {
      if (_appsRenderKey !== '__empty__') {
        grid.innerHTML = '';
        _appsRenderKey = '__empty__';
      }
      if (empty) empty.style.display = '';
      return;
    }

    // Skip rebuild if nothing changed (id/version/status/updatedAt are enough)
    const nextKey = apps.map(a => `${a.id}:${a.version || 0}:${a.status || 'active'}:${a.updatedAt || 0}`).join('|');
    if (nextKey === _appsRenderKey) { if (empty) empty.style.display = 'none'; return; }
    _appsRenderKey = nextKey;

    if (empty) empty.style.display = 'none';
    grid.style.display = 'grid';
    grid.innerHTML = apps.map(a => {
      const statusClass = a.status !== 'active' ? ` app-card-${esc(a.status)}` : '';
      const statusBadge = a.status !== 'active'
        ? `<span class="app-card-status app-card-status-${esc(a.status)}">${esc(a.status)}</span>`
        : '';
      const visibilityIcon = a.visibility === 'private' ? '&#128274;' : a.visibility === 'public' ? '&#127760;' : '&#128101;';

      return `
      <div class="app-card${statusClass}" onclick="openApp('${esc(a.url || '/apps/' + a.id)}')">
        <div class="app-card-header">
          <span class="app-card-name" data-id="${esc(a.id)}" onclick="event.stopPropagation(); renameApp(this)" title="Click to rename">${esc(a.name)}</span>
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
          <button class="app-action-btn" onclick="openApp('${esc(a.url || '/apps/' + a.id)}')" title="Open in new tab">Open</button>
          <button class="app-action-btn edit" onclick="enterIdeView('${esc(a.id)}','${esc(a.name)}','${esc(a.url || '/apps/' + a.id)}')" title="Edit in IDE">Edit</button>
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
    // Stagger-animate app cards in
    if (typeof Spring !== 'undefined') {
      Spring.staggerIn(Array.from(grid.querySelectorAll('.app-card')), { delay: 40, preset: 'stiff' });
    }
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

function openApp(urlOrId) {
  // Accept full URL or just an ID
  const target = urlOrId.startsWith('http') || urlOrId.startsWith('/') ? urlOrId : '/apps/' + urlOrId;
  window.open(target, '_blank');
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

// Click-to-edit on app name. Swaps the span for an input; Enter commits,
// Escape cancels. On commit, POSTs /api/apps/<id>/rename which moves the
// workspace folder AND updates any sidebar pin URLs that referenced it.
function renameApp(el) {
  if (el._editing) return;
  el._editing = true;
  const id = el.getAttribute('data-id');
  const originalName = el.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = originalName;
  input.className = 'app-card-name-input';
  input.style.cssText = 'font:inherit;color:inherit;background:var(--bg);border:1px solid var(--accent);border-radius:4px;padding:2px 6px;width:90%;outline:none';
  el.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === originalName) { cancel(); return; }
    try {
      const r = await fetch(`${API}/api/apps/${id}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({ name: newName }),
      });
      const data = await r.json();
      if (!r.ok) { alert('Rename failed: ' + (data.error || r.status)); cancel(); return; }
      _appsRenderKey = ''; // force re-render
      loadApps();
    } catch (e) { alert('Rename error: ' + e.message); cancel(); }
  };
  const cancel = () => {
    const span = document.createElement('span');
    span.className = 'app-card-name';
    span.setAttribute('data-id', id);
    span.setAttribute('title', 'Click to rename');
    span.textContent = originalName;
    span.onclick = (e) => { e.stopPropagation(); renameApp(span); };
    input.replaceWith(span);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', cancel);
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

function sendAppsChatMessage() {
  const input = document.getElementById('apps-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  // Enter IDE view for new app creation
  const slug = text.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-app';
  enterIdeView(slug, text.slice(0, 50), null, text);
}

function promptCreateApp() {
  const input = document.getElementById('apps-chat-input');
  if (input) { input.focus(); return; }
  navigate('chat');
  const chatInput = document.getElementById('msg-input');
  if (chatInput) {
    chatInput.value = 'Create an app for me: ';
    chatInput.focus();
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
window.sendAppsChatMessage = sendAppsChatMessage;
window.onAppsProviderChange = onAppsProviderChange;
window.renameApp = renameApp;
window.onAppsModelChange = onAppsModelChange;
