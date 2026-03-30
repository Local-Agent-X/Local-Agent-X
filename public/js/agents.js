// ── Agents Page ──

async function init_agents() {
  loadOrgs();
  loadTeam();
  loadInbox();
  loadIssues();
  loadAgentHistory();
  loadAgentTemplates();
  loadActiveAgents();
}
window.init_agents = init_agents;

// ── Slide-out detail panel ──

function openAgentPanel() {
  const overlay = document.getElementById('agents-detail-overlay');
  const panel = document.getElementById('agents-detail-panel');
  const detail = document.getElementById('agents-detail-view');
  const form = document.getElementById('agents-template-form');
  if (overlay) overlay.style.display = '';
  if (panel) panel.style.display = '';
  if (detail) detail.style.display = '';
  if (form) form.style.display = 'none';
}

function openAgentForm() {
  const overlay = document.getElementById('agents-detail-overlay');
  const panel = document.getElementById('agents-detail-panel');
  const detail = document.getElementById('agents-detail-view');
  const form = document.getElementById('agents-template-form');
  if (overlay) overlay.style.display = '';
  if (panel) panel.style.display = '';
  if (detail) detail.style.display = 'none';
  if (form) form.style.display = '';
}

function closeAgentDetail() {
  const overlay = document.getElementById('agents-detail-overlay');
  const panel = document.getElementById('agents-detail-panel');
  if (overlay) overlay.style.display = 'none';
  if (panel) panel.style.display = 'none';
}

// ── Organization management ──

let _currentOrg = '';

async function loadOrgs() {
  const sel = document.getElementById('agents-org-select');
  if (!sel) return;
  try {
    const r = await fetch(`${API}/api/projects`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const projects = await r.json();
    sel.innerHTML = '<option value="">All Organizations</option>' +
      (Array.isArray(projects) ? projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') : '');
  } catch {}
}

function switchOrg(orgId) {
  _currentOrg = orgId;
  loadTeam();
  loadIssues();
  loadOrgChart();
}

function showNewOrgForm() {
  openAgentForm();
  const form = document.getElementById('agents-template-form');
  if (!form) return;
  form.innerHTML = `
    <h2 style="font-family:var(--mono);font-size:1rem;color:var(--accent);margin-bottom:16px">New Organization</h2>
    <div class="field"><label class="field-label">Name</label><input class="field-input" id="org-name" placeholder="e.g. Marketing Team, My Startup"></div>
    <div class="field"><label class="field-label">Description</label><textarea class="field-input" id="org-desc" rows="3" style="resize:vertical" placeholder="What this organization does..."></textarea></div>
    <div class="field"><label class="field-label">Workspace folder (optional)</label><input class="field-input" id="org-workspace" placeholder="e.g. ./workspace/marketing"></div>
    <div style="margin-top:12px">
      <div class="field-label" style="margin-bottom:8px">Quick Start — hire agents for this org:</div>
      <div id="org-agent-picks" style="display:flex;flex-wrap:wrap;gap:6px"></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="action-btn primary" onclick="createOrg()">Create Organization</button>
      <button class="action-btn secondary" onclick="closeAgentDetail()">Cancel</button>
    </div>
  `;
  // Load agent templates as checkboxes
  fetch(\`\${API}/api/agents/templates\`, { headers: { Authorization: \`Bearer \${AUTH_TOKEN}\` } })
    .then(r => r.json())
    .then(templates => {
      const el = document.getElementById('org-agent-picks');
      if (!el || !Array.isArray(templates)) return;
      el.innerHTML = templates.map(t => \`
        <label style="display:flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:.72rem;cursor:pointer">
          <input type="checkbox" value="\${t.id}" style="accent-color:var(--accent)"> \${t.icon || ''} \${esc(t.name)}
        </label>
      \`).join('');
    }).catch(() => {});
}

async function createOrg() {
  const name = document.getElementById('org-name')?.value.trim();
  const desc = document.getElementById('org-desc')?.value.trim();
  const workspace = document.getElementById('org-workspace')?.value.trim();
  if (!name) { alert('Name is required'); return; }
  // Get selected agents
  const checks = document.querySelectorAll('#org-agent-picks input:checked');
  const agentIds = Array.from(checks).map(c => c.value);
  try {
    await fetch(\`\${API}/api/projects/from-starter\`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${AUTH_TOKEN}\` },
      body: JSON.stringify({ name, description: desc, workspace, agentIds })
    });
    closeAgentDetail();
    loadOrgs();
    loadTeam();
  } catch {}
}

// ── Tab switching ──

function switchAgentsTab(tab, btn) {
  document.querySelectorAll('.agents-tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.agents-tab').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('agents-tab-' + tab);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');
  // Refresh data
  if (tab === 'team') loadTeam();
  if (tab === 'inbox') loadInbox();
  if (tab === 'issues') loadIssues();
  if (tab === 'history') loadAgentHistory();
  if (tab === 'templates') loadAgentTemplates();
  if (tab === 'active') loadActiveAgents();
  if (tab === 'orgchart') loadOrgChart();
}

// ── Team (hired agents) ──

async function loadTeam() {
  const list = document.getElementById('agents-team-list');
  if (!list) return;
  list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);font-size:.78rem">Loading team...</div>';
  try {
    const r = await fetch(`${API}/api/agents/hired`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    let agents = await r.json();
    // Filter by selected org
    if (_currentOrg && Array.isArray(agents)) {
      const pr = await fetch(`${API}/api/projects/${_currentOrg}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
      const proj = await pr.json();
      if (proj && Array.isArray(proj.agentIds)) {
        const orgSet = new Set(proj.agentIds);
        agents = agents.filter(a => orgSet.has(a.id));
      }
    }
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

async function showHiredAgent(id) {
  openAgentPanel();
  const detail = document.getElementById('agents-detail-view');
  try {
    const r = await fetch(`${API}/api/agents/templates`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const templates = await r.json();
    const a = templates.find(t => t.id === id);
    if (!a || !detail) return;
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

async function fireAgent(id) {
  if (!confirm('Fire this agent? Their heartbeat will stop.')) return;
  try {
    await fetch(`${API}/api/agents/templates/${id}/fire`, { method: 'POST', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    loadTeam();
    closeAgentDetail();
  } catch {}
}

// ── Inbox ──

async function loadInbox() {
  const list = document.getElementById('agents-inbox-list');
  const badge = document.getElementById('inbox-badge');
  if (!list) return;
  try {
    const r = await fetch(`${API}/api/inbox`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const items = await r.json();
    if (badge) {
      badge.textContent = items.length;
      badge.style.display = items.length > 0 ? '' : 'none';
    }
    if (!Array.isArray(items) || items.length === 0) {
      list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);font-size:.78rem">Nothing needs your approval</div>';
      return;
    }
    list.innerHTML = items.map(i => `
      <div class="agent-history-item" style="border-left:3px solid var(--warn)">
        <div class="agent-history-header">
          <span class="agent-role-badge" style="background:rgba(255,170,0,.15);color:var(--warn)">${esc(i.approvalType || 'approval')}</span>
          <span style="font-size:.65rem;font-family:var(--mono);color:var(--muted)">${i.id}</span>
        </div>
        <div class="agent-history-name">${esc(i.title)}</div>
        <div class="agent-history-task">${esc(i.description.slice(0, 100))}</div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button class="action-btn primary" style="font-size:.68rem;padding:3px 12px" onclick="event.stopPropagation();approveIssue('${i.id}')">Approve</button>
          <button class="action-btn danger" style="font-size:.68rem;padding:3px 12px" onclick="event.stopPropagation();rejectIssue('${i.id}')">Reject</button>
        </div>
      </div>
    `).join('');
  } catch { list.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">Failed to load</div>'; }
}

async function approveIssue(id) {
  try {
    await fetch(`${API}/api/issues/${id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    loadInbox();
    loadIssues();
  } catch {}
}

async function rejectIssue(id) {
  const reason = prompt('Reason for rejection (optional):');
  try {
    await fetch(`${API}/api/issues/${id}/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ reason: reason || '' })
    });
    loadInbox();
    loadIssues();
  } catch {}
}

// ── Issues ──

async function loadIssues() {
  const list = document.getElementById('agents-issues-list');
  if (!list) return;
  try {
    const r = await fetch(`${API}/api/issues`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const issues = await r.json();
    if (!Array.isArray(issues) || issues.length === 0) {
      list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);font-size:.78rem">No issues yet. Create one to assign work to an agent.</div>';
      return;
    }
    list.innerHTML = issues.map(i => `
      <div class="agent-history-item ${i.status}" onclick="showIssueDetail('${i.id}')">
        <div class="agent-history-header">
          <span style="font-family:var(--mono);font-size:.65rem;color:var(--accent)">${i.id}</span>
          <span class="agent-role-badge">${i.status}</span>
        </div>
        <div class="agent-history-name">${esc(i.title)}</div>
        <div class="agent-history-meta">
          <span>${i.assignee ? 'Assigned: ' + esc(i.assignee) : 'Unassigned'}</span>
          <span>${i.priority}</span>
          <span>${timeAgo(i.updatedAt)}</span>
        </div>
      </div>
    `).join('');
  } catch { list.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">Failed to load</div>'; }
}

async function showIssueDetail(id) {
  openAgentPanel();
  const detail = document.getElementById('agents-detail-view');
  try {
    const r = await fetch(`${API}/api/issues/${id}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const i = await r.json();
    if (!detail) return;
    const statusColor = { open: 'var(--accent)', 'in-progress': 'var(--warn)', blocked: 'var(--danger)', done: '#4caf50', cancelled: 'var(--muted)' }[i.status] || 'var(--muted)';
    detail.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="font-family:var(--mono);font-size:.9rem;color:var(--accent)">${i.id}: ${esc(i.title)}</h2>
        <span style="font-size:.7rem;font-family:var(--mono);color:${statusColor};border:1px solid ${statusColor};padding:2px 10px;border-radius:10px">${i.status.toUpperCase()}</span>
      </div>
      <div class="agent-detail-grid">
        <div class="agent-detail-field"><span class="agent-detail-label">Assignee</span><span>${esc(i.assignee || 'Unassigned')}</span></div>
        <div class="agent-detail-field"><span class="agent-detail-label">Priority</span><span>${esc(i.priority)}</span></div>
        <div class="agent-detail-field"><span class="agent-detail-label">Created By</span><span>${esc(i.createdBy)}</span></div>
        <div class="agent-detail-field"><span class="agent-detail-label">Created</span><span>${new Date(i.createdAt).toLocaleString()}</span></div>
      </div>
      <div style="margin-top:12px">
        <div class="agent-detail-label">Description</div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:.8rem;line-height:1.5;margin-top:4px">${esc(i.description || 'No description')}</div>
      </div>
      <div style="margin-top:12px">
        <div class="agent-detail-label">Status</div>
        <select class="field-input" style="font-size:.75rem;padding:4px 8px;margin-top:4px" onchange="updateIssueStatus('${i.id}',this.value)">
          <option value="open" ${i.status==='open'?'selected':''}>Open</option>
          <option value="in-progress" ${i.status==='in-progress'?'selected':''}>In Progress</option>
          <option value="blocked" ${i.status==='blocked'?'selected':''}>Blocked</option>
          <option value="done" ${i.status==='done'?'selected':''}>Done</option>
          <option value="cancelled" ${i.status==='cancelled'?'selected':''}>Cancelled</option>
        </select>
      </div>
      ${i.comments && i.comments.length > 0 ? `
        <div style="margin-top:12px">
          <div class="agent-detail-label">Comments (${i.comments.length})</div>
          ${i.comments.map(c => `
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin-top:6px;font-size:.78rem">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span style="font-family:var(--mono);color:var(--accent);font-size:.68rem">${esc(c.author)}</span>
                <span style="color:var(--muted);font-size:.65rem">${timeAgo(c.createdAt)}</span>
              </div>
              <div style="line-height:1.4">${esc(c.content)}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div style="margin-top:12px;display:flex;gap:6px">
        <input id="issue-comment-input" class="field-input" style="flex:1;font-size:.75rem;padding:6px 10px" placeholder="Add a comment...">
        <button class="action-btn primary" style="font-size:.7rem" onclick="addIssueComment('${i.id}')">Comment</button>
      </div>
      <div style="margin-top:12px">
        <button class="action-btn danger" style="font-size:.7rem" onclick="deleteIssue('${i.id}')">Delete Issue</button>
      </div>
    `;
  } catch { if (detail) detail.innerHTML = '<p style="color:var(--muted)">Failed to load issue</p>'; }
}

async function updateIssueStatus(id, status) {
  try {
    await fetch(`${API}/api/issues/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ status })
    });
    loadIssues();
  } catch {}
}

async function addIssueComment(id) {
  const input = document.getElementById('issue-comment-input');
  if (!input || !input.value.trim()) return;
  try {
    await fetch(`${API}/api/issues/${id}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ content: input.value.trim(), author: 'user' })
    });
    input.value = '';
    showIssueDetail(id);
  } catch {}
}

async function deleteIssue(id) {
  if (!confirm('Delete this issue?')) return;
  try {
    await fetch(`${API}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    loadIssues();
    closeAgentDetail();
  } catch {}
}

function showIssueForm(assignee) {
  openAgentForm();
  const form = document.getElementById('agents-template-form');
  form.innerHTML = `
    <h2 style="font-family:var(--mono);font-size:1rem;color:var(--accent);margin-bottom:16px">New Issue</h2>
    <div class="field"><label class="field-label">Title</label><input class="field-input" id="issue-title" placeholder="e.g. Build landing page"></div>
    <div class="field"><label class="field-label">Description</label><textarea class="field-input" id="issue-desc" rows="4" style="resize:vertical" placeholder="What needs to be done..."></textarea></div>
    <div class="field"><label class="field-label">Assignee (agent ID)</label><input class="field-input" id="issue-assignee" value="${assignee || ''}" placeholder="e.g. builtin-coder"></div>
    <div class="field"><label class="field-label">Priority</label>
      <select class="field-input" id="issue-priority">
        <option value="low">Low</option>
        <option value="medium" selected>Medium</option>
        <option value="high">High</option>
        <option value="urgent">Urgent</option>
      </select>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="action-btn primary" onclick="createIssue()">Create Issue</button>
      <button class="action-btn secondary" onclick="cancelTemplateForm()">Cancel</button>
    </div>
  `;
}

async function createIssue() {
  const title = document.getElementById('issue-title')?.value.trim();
  const desc = document.getElementById('issue-desc')?.value.trim();
  const assignee = document.getElementById('issue-assignee')?.value.trim();
  const priority = document.getElementById('issue-priority')?.value;
  if (!title) { alert('Title is required'); return; }
  try {
    await fetch(`${API}/api/issues`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ title, description: desc, assignee, priority, status: 'open', createdBy: 'user' })
    });
    loadIssues();
    cancelTemplateForm();
  } catch {}
}

// ── Org Chart (drag-and-drop hierarchy) ──

let _orgAgents = [];
let _orgDragId = null;

async function loadOrgChart() {
  const container = document.getElementById('orgchart-container');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">Loading...</div>';
  try {
    const r = await fetch(`${API}/api/agents/hired`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    _orgAgents = await r.json();
    if (!Array.isArray(_orgAgents) || _orgAgents.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)"><div style="font-size:2rem;margin-bottom:8px">&#129302;</div><div>No agents hired. Go to Templates to hire your team.</div></div>';
      return;
    }
    renderOrgChart(container);
  } catch { container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px">Failed to load</div>'; }
}

function renderOrgChart(container) {
  // Build tree: root nodes have no reportsTo or reportsTo not in hired list
  const hiredIds = new Set(_orgAgents.map(a => a.id));
  const roots = _orgAgents.filter(a => !a.reportsTo || !hiredIds.has(a.reportsTo));
  const childMap = {};
  for (const a of _orgAgents) {
    if (a.reportsTo && hiredIds.has(a.reportsTo)) {
      if (!childMap[a.reportsTo]) childMap[a.reportsTo] = [];
      childMap[a.reportsTo].push(a);
    }
  }

  // Add "You (Board)" as the root
  let html = '<div class="org-tree">';
  html += '<div class="org-node org-board">&#128100; You (Board)</div>';
  html += '<div class="org-children">';
  for (const root of roots) {
    html += renderOrgNode(root, childMap);
  }
  // Unassigned drop zone
  html += `<div class="org-dropzone" data-target="" ondragover="orgDragOver(event)" ondrop="orgDrop(event)">
    <span style="color:var(--muted);font-size:.7rem">Drop here to unassign</span>
  </div>`;
  html += '</div></div>';

  container.innerHTML = html;
}

function renderOrgNode(agent, childMap) {
  const children = childMap[agent.id] || [];
  const hasChildren = children.length > 0;
  let html = `<div class="org-branch">`;
  html += `<div class="org-node" draggable="true" data-id="${agent.id}"
    ondragstart="orgDragStart(event,'${agent.id}')"
    ondragover="orgDragOver(event)"
    ondrop="orgDrop(event)"
    onclick="showHiredAgent('${agent.id}')">
    <div class="org-node-icon">${agent.icon || '&#129302;'}</div>
    <div class="org-node-name">${esc(agent.name)}</div>
    <div class="org-node-role">${esc(agent.role)}</div>
    ${agent.heartbeatEnabled ? '<div class="org-node-heartbeat">&#128154; Active</div>' : ''}
  </div>`;
  if (hasChildren) {
    html += '<div class="org-children">';
    for (const child of children) {
      html += renderOrgNode(child, childMap);
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function orgDragStart(e, agentId) {
  _orgDragId = agentId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', agentId);
  e.target.closest('.org-node').classList.add('org-dragging');
}

function orgDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const node = e.target.closest('.org-node, .org-dropzone');
  if (node) node.classList.add('org-drop-target');
}

function orgDrop(e) {
  e.preventDefault();
  document.querySelectorAll('.org-dragging, .org-drop-target').forEach(el => {
    el.classList.remove('org-dragging', 'org-drop-target');
  });
  const targetNode = e.target.closest('.org-node, .org-dropzone');
  if (!targetNode || !_orgDragId) return;
  const targetId = targetNode.dataset.id || targetNode.dataset.target || '';
  if (targetId === _orgDragId) return; // Can't report to self

  // Update the hierarchy
  updateAgentHierarchy(_orgDragId, targetId || null);
  _orgDragId = null;
}

async function updateAgentHierarchy(agentId, reportsTo) {
  try {
    await fetch(`${API}/api/agents/templates/${agentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ reportsTo: reportsTo || '' })
    });
    // Reload
    loadOrgChart();
  } catch {}
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
  openAgentPanel();
  const detail = document.getElementById('agents-detail-view');
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
    closeAgentDetail();
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
  openAgentForm();
  const form = document.getElementById('agents-template-form');
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
      ${isEdit && !t.hired ? `<button class="action-btn secondary" onclick="hireAgent('${t.id}')">Hire Agent</button>` : ''}
      ${isEdit && t.hired ? `<span style="color:var(--accent);font-size:.72rem;font-family:var(--mono)">HIRED</span>` : ''}
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

async function hireAgent(id) {
  const schedule = prompt('Heartbeat schedule (e.g. "every 4h", "daily 9am", or leave empty for no heartbeat):');
  try {
    await fetch(`${API}/api/agents/templates/${id}/hire`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ heartbeatSchedule: schedule || undefined })
    });
    alert('Agent hired!');
    loadTeam();
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
  closeAgentDetail();
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
