// Project management: dropdown population, new-project form, and the
// switchProject side-effect that re-fetches tab data scoped to the new
// project. Loads agent templates as checkboxes in the "Quick Start" picker
// so the user can pre-hire on creation.

import { state } from './state.js';
import { esc } from './helpers.js';
import { openAgentForm, closeAgentDetail } from './panel.js';
import { loadTeam } from './team.js';
import { loadIssues } from './issues.js';
import { loadOrgChart } from './orgchart.js';
import { loadDashboard } from './dashboard.js';

export async function loadProjects() {
  const sel = document.getElementById('agents-project-select');
  if (!sel) return;
  try {
    const r = await fetch(`${API}/api/projects`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const projects = await r.json();
    sel.innerHTML = '<option value="">All Projects</option>' +
      (Array.isArray(projects) ? projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') : '');
  } catch {}
}

export function switchProject(orgId) {
  state.currentProject = orgId;
  loadDashboard();
  loadTeam();
  loadIssues();
  loadOrgChart();
}

export function showNewProjectForm() {
  openAgentForm();
  const form = document.getElementById('agents-template-form');
  if (!form) return;
  form.innerHTML = `
    <h2 style="font-family:var(--mono);font-size:1rem;color:var(--accent);margin-bottom:16px">New Project</h2>
    <div class="field"><label class="field-label">Name</label><input class="field-input" id="project-name" placeholder="e.g. Marketing Team, My Startup"></div>
    <div class="field"><label class="field-label">Description</label><textarea class="field-input" id="project-desc" rows="3" style="resize:vertical" placeholder="What this project does..."></textarea></div>
    <div class="field"><label class="field-label">Workspace folder (optional)</label><input class="field-input" id="project-workspace" placeholder="e.g. ./workspace/marketing"></div>
    <div style="margin-top:12px">
      <div class="field-label" style="margin-bottom:8px">Quick Start — hire agents for this project:</div>
      <div id="project-agent-picks" style="display:flex;flex-wrap:wrap;gap:6px"></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="action-btn primary" onclick="createProject()">Create Project</button>
      <button class="action-btn secondary" onclick="closeAgentDetail()">Cancel</button>
    </div>
  `;
  // Load agent templates as checkboxes
  fetch(API + '/api/agents/templates', { headers: { Authorization: 'Bearer ' + AUTH_TOKEN } })
    .then(function(r) { return r.json(); })
    .then(function(templates) {
      var el = document.getElementById('project-agent-picks');
      if (!el || !Array.isArray(templates)) return;
      el.innerHTML = templates.map(function(t) {
        return '<label style="display:flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:.72rem;cursor:pointer">' +
          '<input type="checkbox" value="' + t.id + '" style="accent-color:var(--accent)"> ' + (t.icon || '') + ' ' + esc(t.name) +
          '</label>';
      }).join('');
    }).catch(function() {});
}

export async function createProject() {
  const name = document.getElementById('project-name')?.value.trim();
  const desc = document.getElementById('project-desc')?.value.trim();
  const workspace = document.getElementById('project-workspace')?.value.trim();
  if (!name) { alert('Name is required'); return; }
  // Get selected agents
  const checks = document.querySelectorAll('#project-agent-picks input:checked');
  const agentIds = Array.from(checks).map(c => c.value);
  try {
    await fetch(API + '/api/projects/from-starter', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AUTH_TOKEN },
      body: JSON.stringify({ name, description: desc, workspace, agentIds })
    });
    closeAgentDetail();
    loadProjects();
    loadTeam();
  } catch {}
}

window.loadProjects = loadProjects;
window.switchProject = switchProject;
window.showNewProjectForm = showNewProjectForm;
window.createProject = createProject;
