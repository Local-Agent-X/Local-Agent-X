// ── Secrets Panel ──
let secrets = [];
let selectedSecret = null;

function init_secrets() { loadSecrets(); }

async function loadSecrets() {
  try {
    const result = await apiJson('/api/secrets');
    secrets = Array.isArray(result) ? result : [];
  } catch { secrets = []; }
  renderSecretsList();
}

function renderSecretsList() {
  document.getElementById('secret-count').textContent = secrets.length;
  const el = document.getElementById('secrets-list');
  if (!el) return;
  if (secrets.length === 0) { el.innerHTML = '<div style="padding:12px;font-size:.78rem;color:var(--muted)">No secrets stored yet.</div>'; return; }
  el.innerHTML = secrets.map(s => `
    <div class="secret-item ${selectedSecret?.name === s.name ? 'active' : ''}" onclick="selectSecretItem('${esc(s.name)}')">
      <span class="secret-dot"></span>
      <div class="secret-info">
        <div class="secret-item-name">${esc(s.name)}</div>
        ${s.service ? `<div class="secret-item-service">${esc(s.service)}</div>` : ''}
      </div>
    </div>
  `).join('');
}

function selectSecretItem(name) {
  selectedSecret = secrets.find(s => s.name === name) || null;
  renderSecretsList();
  renderSecretDetail();
}

function renderSecretDetail() {
  const empty = document.getElementById('secret-detail-empty');
  const view = document.getElementById('secret-detail-view');
  if (!selectedSecret) { empty.style.display = 'flex'; view.style.display = 'none'; return; }
  empty.style.display = 'none'; view.style.display = 'block';
  document.getElementById('detail-name').textContent = selectedSecret.name;
  document.getElementById('detail-service').textContent = selectedSecret.service ? `Service: ${selectedSecret.service}` : '';
  document.getElementById('detail-usage').textContent = `{{${selectedSecret.name}}}`;
  const fmt = ts => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  document.getElementById('detail-meta').innerHTML = `Added: ${fmt(selectedSecret.addedAt)}<br>Updated: ${fmt(selectedSecret.updatedAt)}`;
}

async function addSecret() {
  const name = document.getElementById('new-secret-name').value.trim();
  const value = document.getElementById('new-secret-value').value.trim();
  const service = document.getElementById('new-secret-service').value.trim();
  if (!name || !value) return;
  await apiPost('/api/secrets', { name, value, service: service || undefined });
  document.getElementById('new-secret-name').value = '';
  document.getElementById('new-secret-value').value = '';
  document.getElementById('new-secret-service').value = '';
  await loadSecrets();
  selectSecretItem(name.toUpperCase().replace(/[^A-Z0-9_]/g, '_'));
}

async function updateSecretValue() {
  if (!selectedSecret) return;
  const value = prompt('New value for ' + selectedSecret.name + ':');
  if (!value) return;
  await apiPost('/api/secrets', { name: selectedSecret.name, value, service: selectedSecret.service });
  await loadSecrets();
}

async function deleteSecretItem() {
  if (!selectedSecret || !confirm(`Delete "${selectedSecret.name}"?`)) return;
  await apiFetch(`/api/secrets/${encodeURIComponent(selectedSecret.name)}`, { method: 'DELETE' });
  selectedSecret = null; await loadSecrets(); renderSecretDetail();
}
