// Team tab: list of hired agents + the per-agent detail panel. Also owns
// the provider registry cache and the cascading model-picker (provider →
// model) shown inside the detail panel. Model overrides are PATCHed to
// the per-project roster entry, not the template.

import { state } from './state.js';
import { esc } from './helpers.js';
import { openAgentPanel, closeAgentDetail } from './panel.js';

export async function loadTeam() {
  const list = document.getElementById('agents-team-list');
  if (!list) return;
  list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);font-size:.78rem">Loading team...</div>';
  try {
    // Project-scoped fetch gets the response merged with roster
    // metadata (heartbeat / reportsTo); without a project we get the
    // template-only shape (no per-agent heartbeat to render).
    const url = state.currentProject
      ? `${API}/api/agents/hired?projectId=${encodeURIComponent(state.currentProject)}`
      : `${API}/api/agents/hired`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    let agents = await r.json();
    if (!Array.isArray(agents)) agents = [];
    if (!Array.isArray(agents) || agents.length === 0) {
      list.innerHTML = `<div style="text-align:center;padding:30px;color:var(--muted)">
        <div style="font-size:2rem;margin-bottom:8px">&#129302;</div>
        <div style="font-size:.85rem;margin-bottom:12px">No agents hired yet</div>
        <div style="font-size:.75rem;line-height:1.5;max-width:280px;margin:0 auto 16px">Hire agents from the Templates tab to build your team. Each agent has a role, tools, and can be assigned tasks.</div>
        <button class="action-btn primary" style="font-size:.72rem" onclick="switchAgentsTab('templates',document.querySelector('.agents-tab:nth-child(4)'))">Browse Templates</button>
      </div>`;
      return;
    }
    list.innerHTML = agents.map(a => `
      <div class="org-node" style="cursor:pointer;text-align:center;padding:16px" onclick="showHiredAgent('${a.id}')">
        <div style="font-size:2rem;margin-bottom:6px">${a.icon || '&#129302;'}</div>
        <div class="org-node-name">${esc(a.name)}</div>
        <div class="org-node-role">${esc(a.role)}</div>
        <div style="margin-top:8px;display:flex;gap:4px;justify-content:center;flex-wrap:wrap">
          ${a.heartbeatEnabled ? '<span class="agent-role-badge" style="background:rgba(76,175,80,.15);color:#4caf50">Active</span>' : '<span class="agent-role-badge">Manual</span>'}
        </div>
      </div>
    `).join('');
  } catch { list.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">Failed to load</div>'; }
}

// Provider registry cache — loaded on first hired-agent panel open. Keyed by
// provider id, value is {label, models[], defaultModel}. Source: GET
// /api/providers/registry (single source of truth in src/providers/registry.ts).
export async function getProviderRegistry() {
  if (state.providerRegistry) return state.providerRegistry;
  try {
    const r = await fetch(`${API}/api/providers/registry`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const data = await r.json();
    state.providerRegistry = Array.isArray(data.providers) ? data.providers : [];
  } catch { state.providerRegistry = []; }
  return state.providerRegistry;
}

// Render the per-agent model picker — two cascading <select>s. Hidden when
// no project is selected (model is a per-roster pin, can't set without one).
function renderModelPicker(agentId, currentModel, registry) {
  if (!state.currentProject) {
    return `<div class="agent-detail-field"><span class="agent-detail-label">Model</span><span style="color:var(--muted);font-size:.7rem">Select a project to assign a model</span></div>`;
  }
  const selectedProvider = currentModel?.provider || '';
  const providerOpts = ['<option value="">Use template default</option>']
    .concat(registry.map(p => `<option value="${esc(p.id)}" ${p.id===selectedProvider?'selected':''}>${esc(p.label)}</option>`))
    .join('');
  const selectedProviderEntry = registry.find(p => p.id === selectedProvider);
  const modelList = selectedProviderEntry?.models || [];
  const selectedModel = currentModel?.model || '';
  const modelOpts = ['<option value="">Use template default</option>']
    .concat(modelList.map(m => `<option value="${esc(m)}" ${m===selectedModel?'selected':''}>${esc(m)}</option>`))
    .join('');
  return `
    <div style="margin-top:12px">
      <div class="agent-detail-label">Model (per-project override)</div>
      <div style="display:flex;gap:6px;margin-top:4px">
        <select id="agent-model-provider" class="field-input" style="flex:1;font-size:.75rem;padding:4px 8px" onchange="onAgentProviderChange('${agentId}')">${providerOpts}</select>
        <select id="agent-model-name" class="field-input" style="flex:1;font-size:.75rem;padding:4px 8px" onchange="onAgentModelChange('${agentId}')" ${selectedProvider?'':'disabled'}>${modelOpts}</select>
      </div>
      <div style="font-size:.65rem;color:var(--muted);margin-top:4px;line-height:1.4">Overrides the template default for this project only. Pick "Use template default" on either dropdown to clear the override.</div>
    </div>`;
}

export async function onAgentProviderChange(agentId) {
  const provSel = document.getElementById('agent-model-provider');
  const modelSel = document.getElementById('agent-model-name');
  if (!provSel || !modelSel) return;
  const provider = provSel.value;
  const registry = await getProviderRegistry();
  const entry = registry.find(p => p.id === provider);
  const models = entry?.models || [];
  modelSel.innerHTML = '<option value="">Use template default</option>' +
    models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  modelSel.disabled = !provider;
  // If the user picked a provider, default to its flagship so the PATCH
  // is well-formed (validator rejects {provider:"x", model:""} on
  // providers that have a non-empty model list).
  if (provider && entry?.defaultModel) {
    modelSel.value = entry.defaultModel;
    await patchAgentModel(agentId, { provider, model: entry.defaultModel });
  } else if (!provider) {
    await patchAgentModel(agentId, null);
  }
}

export async function onAgentModelChange(agentId) {
  const provSel = document.getElementById('agent-model-provider');
  const modelSel = document.getElementById('agent-model-name');
  if (!provSel || !modelSel) return;
  const provider = provSel.value;
  const model = modelSel.value;
  if (!provider || !model) { await patchAgentModel(agentId, null); return; }
  await patchAgentModel(agentId, { provider, model });
}

async function patchAgentModel(agentId, pin) {
  if (!state.currentProject) return;
  try {
    await fetch(`${API}/api/projects/${state.currentProject}/rosters/${agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ model: pin }),
    });
  } catch (e) { console.error('Failed to update agent model:', e); }
}

export async function showHiredAgent(id) {
  openAgentPanel();
  const detail = document.getElementById('agents-detail-view');
  try {
    // Prefer project-scoped roster fetch so the panel sees the per-project
    // model override + heartbeat metadata. Falls back to template-only when
    // no project is selected (model picker stays hidden in that case).
    let a;
    if (state.currentProject) {
      const r = await fetch(`${API}/api/agents/hired?projectId=${encodeURIComponent(state.currentProject)}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
      const rostered = await r.json();
      a = Array.isArray(rostered) ? rostered.find(t => t.id === id) : null;
    }
    if (!a) {
      const r = await fetch(`${API}/api/agents/templates`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
      const templates = await r.json();
      a = templates.find(t => t.id === id);
    }
    if (!a || !detail) return;
    const registry = await getProviderRegistry();
    // Get issues assigned to this agent
    const ir = await fetch(`${API}/api/issues?assignee=${id}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const issues = await ir.json();
    detail.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="font-family:var(--mono);font-size:1rem;color:var(--accent)">${a.icon || ''} ${esc(a.name)}</h2>
        <button class="action-btn danger" onclick="fireAgent('${a.id}')">Fire</button>
      </div>
      <div class="agent-detail-grid">
        <div class="agent-detail-field"><span class="agent-detail-label">Role</span><span>${esc(a.role)}</span></div>
        <div class="agent-detail-field"><span class="agent-detail-label">Heartbeat</span><span>${a.heartbeatEnabled ? esc(a.heartbeatSchedule) : 'Off'}</span></div>
        ${a.reportsTo ? `<div class="agent-detail-field"><span class="agent-detail-label">Reports To</span><span>${esc(a.reportsTo)}</span></div>` : ''}
        <div class="agent-detail-field"><span class="agent-detail-label">Tools</span><span>${(a.allowedTools || []).join(', ') || 'All'}</span></div>
      </div>
      ${renderModelPicker(a.id, a.model, registry)}
      <div style="margin-top:16px">
        <div class="agent-detail-label">System Prompt</div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:.78rem;line-height:1.5;margin-top:4px;max-height:120px;overflow-y:auto">${esc(a.systemPrompt)}</div>
      </div>
      <div style="margin-top:16px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="agent-detail-label">Assigned Issues (${issues.length})</div>
          <button class="action-btn primary" style="font-size:.68rem;padding:3px 10px" onclick="showIssueForm('${a.id}')">+ Assign Task</button>
        </div>
        <div style="margin-top:8px">${issues.length === 0 ? '<div style="color:var(--muted);font-size:.78rem">No tasks assigned</div>' :
          issues.map(i => `
            <div class="agent-history-item ${i.status}" onclick="showIssueDetail('${i.id}')" style="margin-bottom:4px;border-radius:6px">
              <div style="display:flex;justify-content:space-between;font-size:.72rem">
                <span style="font-family:var(--mono);color:var(--accent)">${i.id}</span>
                <span class="agent-role-badge">${i.status}</span>
              </div>
              <div style="font-size:.78rem;margin-top:2px">${esc(i.title)}</div>
            </div>
          `).join('')}
        </div>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="action-btn primary" onclick="spawnFromTemplate('${a.id}')">Run Task Now</button>
        ${a.heartbeatEnabled ? '<button class="action-btn secondary" onclick="alert(\'Heartbeat will run on schedule\')">Heartbeat Active</button>' : ''}
      </div>
    `;
  } catch { if (detail) detail.innerHTML = '<p style="color:var(--muted)">Failed to load</p>'; }
}

export async function fireAgent(id) {
  if (!state.currentProject) {
    alert('Select a project first — fire is always a Project action.');
    return;
  }
  if (!confirm('Fire this agent from the current project? Their heartbeat will stop.')) return;
  try {
    await fetch(`${API}/api/agents/templates/${id}/fire`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ projectId: state.currentProject })
    });
    loadTeam();
    closeAgentDetail();
  } catch {}
}

window.loadTeam = loadTeam;
window.showHiredAgent = showHiredAgent;
window.fireAgent = fireAgent;
window.onAgentProviderChange = onAgentProviderChange;
window.onAgentModelChange = onAgentModelChange;
