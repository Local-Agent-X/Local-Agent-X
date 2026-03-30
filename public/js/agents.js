// ── Agents Page ──

async function init_agents() {
  loadAgentHistory();
  loadAgentTemplates();
  loadActiveAgents();
}
window.init_agents = init_agents;

// ── Tab switching ──

function switchAgentsTab(tab, btn) {
  document.querySelectorAll('.agents-tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.agents-tab').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('agents-tab-' + tab);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');
  // Refresh data
  if (tab === 'history') loadAgentHistory();
  if (tab === 'templates') loadAgentTemplates();
  if (tab === 'active') loadActiveAgents();
}

// ── History ──

async function loadAgentHistory() {
  const list = document.getElementById('agents-history-list');
  if (!list) return;
  const status = document.getElementById('agents-filter-status')?.value || '';
  try {
    const r = await fetch(`${API}/api/agents/history?limit=100&status=${status}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const data = await r.json();
    const runs = data.runs || [];
    if (runs.length === 0) {
      list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);font-size:.78rem">No agent runs yet</div>';
      return;
    }
    list.innerHTML = runs.map(r => `
      <div class="agent-history-item ${r.status}" onclick="showAgentDetail('${r.id}')">
        <div class="agent-history-header">
          <span class="agent-role-badge">${esc(r.role)}</span>
          <span class="agent-status-dot ${r.status}"></span>
        </div>
        <div class="agent-history-name">${esc(r.name)}</div>
        <div class="agent-history-task">${esc(r.task.slice(0, 80))}</div>
        <div class="agent-history-meta">
          <span>${timeAgo(r.startedAt)}</span>
          <span>${r.toolsUsed?.length || 0} tools</span>
          <span>${formatDuration(r.completedAt - r.startedAt)}</span>
        </div>
      </div>
    `).join('');
  } catch { list.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">Failed to load</div>'; }
}

async function showAgentDetail(id) {
  const empty = document.getElementById('agents-detail-empty');
  const detail = document.getElementById('agents-detail-view');
  const form = document.getElementById('agents-template-form');
  if (empty) empty.style.display = 'none';
  if (form) form.style.display = 'none';
  if (detail) detail.style.display = '';
  try {
    const r = await fetch(`${API}/api/agents/history/${id}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const run = await r.json();
    if (!detail) return;
    const statusColor = run.status === 'done' ? 'var(--accent)' : run.status === 'error' ? 'var(--danger)' : 'var(--warn)';
    detail.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="font-family:var(--mono);font-size:1rem;color:var(--accent)">${esc(run.name)}</h2>
        <span style="font-size:.7rem;font-family:var(--mono);color:${statusColor};border:1px solid ${statusColor};padding:2px 10px;border-radius:10px">${run.status.toUpperCase()}</span>
      </div>
      <div class="agent-detail-grid">
        <div class="agent-detail-field"><span class="agent-detail-label">Role</span><span>${esc(run.role)}</span></div>
        <div class="agent-detail-field"><span class="agent-detail-label">ID</span><span style="font-family:var(--mono);font-size:.7rem">${esc(run.id)}</span></div>
        <div class="agent-detail-field"><span class="agent-detail-label">Duration</span><span>${formatDuration(run.completedAt - run.startedAt)}</span></div>
        <div class="agent-detail-field"><span class="agent-detail-label">Tokens</span><span>${run.tokensUsed || 0}</span></div>
        <div class="agent-detail-field"><span class="agent-detail-label">Started</span><span>${new Date(run.startedAt).toLocaleString()}</span></div>
        ${run.parentAgentId ? `<div class="agent-detail-field"><span class="agent-detail-label">Parent</span><span style="font-family:var(--mono);font-size:.7rem;cursor:pointer;color:var(--accent)" onclick="showAgentDetail('${run.parentAgentId}')">${esc(run.parentAgentId)}</span></div>` : ''}
      </div>
      <div style="margin-top:16px">
        <div class="agent-detail-label">Task</div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:.8rem;line-height:1.5;margin-top:4px">${esc(run.task)}</div>
      </div>
      ${run.toolsUsed && run.toolsUsed.length > 0 ? `
        <div style="margin-top:16px">
          <div class="agent-detail-label">Tools Used</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">
            ${run.toolsUsed.map(t => `<span style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:.68rem;font-family:var(--mono)">${esc(t)}</span>`).join('')}
          </div>
        </div>
      ` : ''}
      <div style="margin-top:16px">
        <div class="agent-detail-label">Result</div>
        <pre style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:.75rem;line-height:1.5;margin-top:4px;white-space:pre-wrap;max-height:400px;overflow-y:auto">${esc(run.result || 'No output')}</pre>
      </div>
      ${run.error ? `
        <div style="margin-top:16px">
          <div class="agent-detail-label" style="color:var(--danger)">Error</div>
          <pre style="background:#1a0505;border:1px solid var(--danger);border-radius:8px;padding:12px;font-size:.75rem;color:var(--danger);margin-top:4px;white-space:pre-wrap">${esc(run.error)}</pre>
        </div>
      ` : ''}
      <div style="margin-top:20px;display:flex;gap:8px">
        <button class="action-btn danger" onclick="deleteAgentRun('${run.id}')">Delete Run</button>
      </div>
    `;
  } catch { if (detail) detail.innerHTML = '<p style="color:var(--muted)">Failed to load agent detail</p>'; }
}

async function deleteAgentRun(id) {
  if (!confirm('Delete this agent run?')) return;
  try {
    await fetch(`${API}/api/agents/history/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    loadAgentHistory();
    document.getElementById('agents-detail-view').style.display = 'none';
    document.getElementById('agents-detail-empty').style.display = '';
  } catch {}
}

// ── Templates ──

async function loadAgentTemplates() {
  const list = document.getElementById('agents-templates-list');
  if (!list) return;
  try {
    const r = await fetch(`${API}/api/agents/templates`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const templates = await r.json();
    if (!Array.isArray(templates) || templates.length === 0) {
      list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);font-size:.78rem">No templates yet. Create one to define reusable agent configs.</div>';
      return;
    }
    list.innerHTML = templates.map(t => `
      <div class="agent-history-item" onclick="showTemplateDetail('${t.id}')">
        <div class="agent-history-header">
          <span class="agent-role-badge">${esc(t.role)}</span>
          <span style="font-size:.6rem;color:var(--muted)">${t.icon || ''}</span>
        </div>
        <div class="agent-history-name">${esc(t.name)}</div>
        <div class="agent-history-task">${esc(t.description || t.systemPrompt.slice(0, 60))}</div>
      </div>
    `).join('');
  } catch { list.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">Failed to load</div>'; }
}

function showTemplateForm(existing) {
  const empty = document.getElementById('agents-detail-empty');
  const detail = document.getElementById('agents-detail-view');
  const form = document.getElementById('agents-template-form');
  if (empty) empty.style.display = 'none';
  if (detail) detail.style.display = 'none';
  if (form) form.style.display = '';
  const t = existing || { id: '', name: '', role: '', systemPrompt: '', description: '', allowedTools: [] };
  const isEdit = !!t.id;
  form.innerHTML = `
    <h2 style="font-family:var(--mono);font-size:1rem;color:var(--accent);margin-bottom:16px">${isEdit ? 'Edit' : 'New'} Agent Template</h2>
    <div class="field"><label class="field-label">Name</label><input class="field-input" id="tpl-name" value="${esc(t.name)}" placeholder="e.g. Code Reviewer"></div>
    <div class="field"><label class="field-label">Role</label><input class="field-input" id="tpl-role" value="${esc(t.role)}" placeholder="e.g. reviewer, coder, researcher"></div>
    <div class="field"><label class="field-label">Description</label><input class="field-input" id="tpl-desc" value="${esc(t.description)}" placeholder="What this agent does"></div>
    <div class="field"><label class="field-label">System Prompt</label><textarea class="field-input" id="tpl-prompt" rows="6" style="resize:vertical" placeholder="You are a...">${esc(t.systemPrompt)}</textarea></div>
    <div class="field"><label class="field-label">Allowed Tools (comma-separated, leave empty for all)</label><input class="field-input" id="tpl-tools" value="${(t.allowedTools || []).join(', ')}" placeholder="read, write, bash, web_fetch"></div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="action-btn primary" onclick="saveTemplate('${t.id}')">${isEdit ? 'Update' : 'Create'}</button>
      <button class="action-btn secondary" onclick="cancelTemplateForm()">Cancel</button>
      ${isEdit ? `<button class="action-btn danger" onclick="deleteTemplate('${t.id}')">Delete</button>` : ''}
    </div>
  `;
}

async function saveTemplate(existingId) {
  const name = document.getElementById('tpl-name')?.value.trim();
  const role = document.getElementById('tpl-role')?.value.trim();
  const desc = document.getElementById('tpl-desc')?.value.trim();
  const prompt = document.getElementById('tpl-prompt')?.value.trim();
  const toolsStr = document.getElementById('tpl-tools')?.value.trim();
  const tools = toolsStr ? toolsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!name || !role) { alert('Name and role are required'); return; }
  const body = { name, role, description: desc, systemPrompt: prompt, allowedTools: tools };
  try {
    if (existingId) {
      await fetch(`${API}/api/agents/templates/${existingId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify(body)
      });
    } else {
      await fetch(`${API}/api/agents/templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify(body)
      });
    }
    loadAgentTemplates();
    cancelTemplateForm();
  } catch {}
}

async function showTemplateDetail(id) {
  try {
    const r = await fetch(`${API}/api/agents/templates`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const templates = await r.json();
    const t = templates.find(tpl => tpl.id === id);
    if (t) showTemplateForm(t);
  } catch {}
}

async function deleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  try {
    await fetch(`${API}/api/agents/templates/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    loadAgentTemplates();
    cancelTemplateForm();
  } catch {}
}

function cancelTemplateForm() {
  const form = document.getElementById('agents-template-form');
  const empty = document.getElementById('agents-detail-empty');
  if (form) form.style.display = 'none';
  if (empty) empty.style.display = '';
}

async function spawnFromTemplate(id) {
  const task = prompt('Enter the task for this agent:');
  if (!task) return;
  try {
    const r = await fetch(`${API}/api/agents/templates/${id}/spawn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ task })
    });
    const data = await r.json();
    if (data.ok) alert('Agent spawned: ' + data.agentId);
  } catch {}
}

// ── Active Agents ──

async function loadActiveAgents() {
  const list = document.getElementById('agents-active-list');
  if (!list) return;
  try {
    const r = await fetch(`${API}/api/agents/active`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const agents = await r.json();
    if (!Array.isArray(agents) || agents.length === 0) {
      list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);font-size:.78rem">No agents currently running</div>';
      return;
    }
    list.innerHTML = agents.map(a => `
      <div class="agent-history-item working" onclick="showAgentDetail('${a.id}')">
        <div class="agent-history-header">
          <span class="agent-role-badge">${esc(a.role)}</span>
          <span class="agent-status-dot working"></span>
        </div>
        <div class="agent-history-name">${esc(a.name)}</div>
        <div class="agent-history-task">${esc(a.currentTask?.slice(0, 80) || '')}</div>
        <div class="agent-history-meta">
          <span>${formatDuration(a.elapsed || 0)}</span>
          <span>${a.tokensUsed || 0} tokens</span>
          <span>${a.progress || 0}%</span>
        </div>
      </div>
    `).join('');
  } catch { list.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">Failed to load</div>'; }
}

// ── Helpers ──

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
