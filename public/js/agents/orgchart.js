// Org Chart tab: drag-and-drop hierarchy editor. Each agent node is
// draggable; dropping onto another node sets reportsTo (project-scoped),
// dropping on the "You (Board)" root or the unassign zone clears it.

import { state } from './state.js';
import { esc } from './helpers.js';

export async function loadOrgChart() {
  const container = document.getElementById('orgchart-container');
  if (!container) return;
  if (!state.currentProject) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)"><div style="font-size:1.5rem;margin-bottom:8px">&#127760;</div><div style="font-size:.85rem">Select a project to see its org chart</div><div style="font-size:.7rem;margin-top:8px;max-width:320px;margin-left:auto;margin-right:auto;line-height:1.4">Org hierarchy (reportsTo) is per-project — same agent can have different managers in different projects.</div></div>';
    return;
  }
  container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">Loading...</div>';
  try {
    const r = await fetch(`${API}/api/agents/hired?projectId=${encodeURIComponent(state.currentProject)}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    state.orgAgents = await r.json();
    if (!Array.isArray(state.orgAgents) || state.orgAgents.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)"><div style="font-size:2rem;margin-bottom:8px">&#129302;</div><div>No agents on this project. Hire from Templates.</div></div>';
      return;
    }
    renderOrgChart(container);
  } catch { container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px">Failed to load</div>'; }
}

function renderOrgChart(container) {
  // Build tree: root nodes have no reportsTo or reportsTo not in hired list
  const hiredIds = new Set(state.orgAgents.map(a => a.id));
  const roots = state.orgAgents.filter(a => !a.reportsTo || !hiredIds.has(a.reportsTo));
  const childMap = {};
  for (const a of state.orgAgents) {
    if (a.reportsTo && hiredIds.has(a.reportsTo)) {
      if (!childMap[a.reportsTo]) childMap[a.reportsTo] = [];
      childMap[a.reportsTo].push(a);
    }
  }

  // Add "You (Board)" as the root
  let html = '<div style="text-align:center;margin-bottom:12px;color:var(--muted);font-size:.72rem">Drag agents onto other agents to set reporting structure</div>';
  html += '<div class="org-tree">';
  html += '<div class="org-node org-board" ondragover="orgDragOver(event)" ondrop="orgDrop(event)" data-id="">&#128100; You (Board)</div>';
  html += '<div class="org-children">';
  for (const root of roots) {
    html += renderOrgNode(root, childMap);
  }
  html += '</div></div>';
  // Unassigned drop zone — outside the tree so it doesn't affect centering
  html += `<div class="org-dropzone" data-target="" ondragover="orgDragOver(event)" ondrop="orgDrop(event)" style="margin:20px auto;max-width:200px;text-align:center">
    <span style="color:var(--muted);font-size:.7rem">Drop here to unassign</span>
  </div>`;

  container.innerHTML = html;
}

function renderOrgNode(agent, childMap) {
  const children = childMap[agent.id] || [];
  const hasChildren = children.length > 0;
  let html = `<div class="org-branch">`;
  html += `<div class="org-node" draggable="true" data-id="${agent.id}"
    ondragstart="orgDragStart(event,'${agent.id}')"
    ondragend="orgDragEnd()"
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

export function orgDragStart(e, agentId) {
  state.orgDragId = agentId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', agentId);
  var node = e.target.closest('.org-node');
  if (node) node.classList.add('org-dragging');
}

export function orgDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  // Clear previous highlights
  document.querySelectorAll('.org-drop-target').forEach(function(el) { el.classList.remove('org-drop-target'); });
  var node = e.target.closest('.org-node, .org-dropzone');
  if (node && node.dataset.id !== state.orgDragId) node.classList.add('org-drop-target');
}

export function orgDragEnd() {
  state.orgDragId = null;
  document.querySelectorAll('.org-dragging, .org-drop-target').forEach(function(el) {
    el.classList.remove('org-dragging', 'org-drop-target');
  });
}

export function orgDrop(e) {
  e.preventDefault();
  document.querySelectorAll('.org-dragging, .org-drop-target').forEach(function(el) {
    el.classList.remove('org-dragging', 'org-drop-target');
  });
  var targetNode = e.target.closest('.org-node, .org-dropzone');
  if (!targetNode || !state.orgDragId) return;
  var targetId = targetNode.dataset.id || targetNode.dataset.target || '';
  if (targetId === state.orgDragId) return;

  updateAgentHierarchy(state.orgDragId, targetId || null);
  state.orgDragId = null;
}

export async function updateAgentHierarchy(agentId, reportsTo) {
  // reportsTo is project-scoped post-L3 — it lives on the project's
  // roster entry, not the template. Org chart hierarchy can only be
  // edited within a project context.
  if (!state.currentProject) {
    alert('Select a project first — org hierarchy is project-scoped.');
    return;
  }
  var container = document.getElementById('orgchart-container');
  if (container) container.style.opacity = '0.5';
  try {
    await fetch(API + '/api/projects/' + state.currentProject + '/rosters/' + agentId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AUTH_TOKEN },
      body: JSON.stringify({ reportsTo: reportsTo || '' })
    });
    await loadOrgChart();
  } catch (err) {
    console.error('Failed to update hierarchy:', err);
  }
  if (container) container.style.opacity = '1';
}

window.loadOrgChart = loadOrgChart;
window.orgDragStart = orgDragStart;
window.orgDragOver = orgDragOver;
window.orgDragEnd = orgDragEnd;
window.orgDrop = orgDrop;
window.updateAgentHierarchy = updateAgentHierarchy;
