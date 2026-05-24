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
  if (secrets.length === 0) {
    el.innerHTML = '<div class="drill-empty">No secrets stored yet. Hit <strong>+ New Secret</strong> to add one — reference them as <code style="color:var(--accent)">{{NAME}}</code> in agent tools.</div>';
    return;
  }
  el.innerHTML = secrets.map(s => `
    <div class="drill-card" onclick="selectSecretItem('${esc(s.name)}')">
      <div class="drill-card-title"><span class="secret-dot"></span>${esc(s.name)}</div>
      ${s.service ? `<div class="drill-card-sub">${esc(s.service)}</div>` : '<div class="drill-card-sub" style="color:var(--muted);opacity:.5">no service</div>'}
    </div>
  `).join('');
}

function selectSecretItem(name) {
  selectedSecret = secrets.find(s => s.name === name) || null;
  if (!selectedSecret) { backToSecretsList(); return; }
  renderSecretDetail();
  showSecretsDetail();
}

function showSecretsDetail() {
  document.getElementById('secrets-list-view')?.classList.add('hidden');
  document.getElementById('secret-detail-view')?.classList.add('active');
}

function backToSecretsList() {
  selectedSecret = null;
  document.getElementById('secret-detail-view')?.classList.remove('active');
  document.getElementById('secrets-list-view')?.classList.remove('hidden');
}

function renderSecretDetail() {
  if (!selectedSecret) return;
  document.getElementById('detail-name').textContent = selectedSecret.name;
  document.getElementById('detail-service').textContent = selectedSecret.service ? `Service: ${selectedSecret.service}` : '';
  document.getElementById('detail-usage').textContent = `{{${selectedSecret.name}}}`;
  const fmt = ts => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  document.getElementById('detail-meta').innerHTML = `Added: ${fmt(selectedSecret.addedAt)}<br>Updated: ${fmt(selectedSecret.updatedAt)}`;
}

function openSecretModal() {
  const o = document.getElementById('secret-create-modal-overlay'); if (!o) return;
  o.classList.add('visible');
  setTimeout(() => document.getElementById('new-secret-name')?.focus(), 50);
}
function closeSecretModal() { document.getElementById('secret-create-modal-overlay')?.classList.remove('visible'); }

async function addSecret() {
  const name = document.getElementById('new-secret-name').value.trim();
  const value = document.getElementById('new-secret-value').value.trim();
  const service = document.getElementById('new-secret-service').value.trim();
  if (!name || !value) { alert('Name and value are required.'); return; }
  await apiPost('/api/secrets', { name, value, service: service || undefined });
  document.getElementById('new-secret-name').value = '';
  document.getElementById('new-secret-value').value = '';
  document.getElementById('new-secret-service').value = '';
  closeSecretModal();
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
  backToSecretsList();
  await loadSecrets();
}
