// Templates tab: agent template CRUD + the hire flow. A template is the
// reusable config (name, role, prompt, allowed tools); hiring rosters it
// into the current project. Hire status is read from the roster, not from
// template.hired (the latter is L3-deprecated and can be stale on disk).

import { state } from './state.js';
import { esc } from './helpers.js';
import { openAgentForm, closeAgentDetail } from './panel.js';
import { loadTeam } from './team.js';

export async function loadAgentTemplates() {
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

async function fetchHiredProjectsForTemplate(templateId) {
  // /api/agents/hired with no projectId returns rostered entries across all
  // projects. We don't trust template.hired -- that field is L3-deprecated and
  // can be stale on disk. Source of truth is the roster.
  try {
    const r = await fetch(`${API}/api/agents/hired`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    if (!r.ok) return [];
    const hired = await r.json();
    if (!Array.isArray(hired)) return [];
    return hired.filter(h => h.id === templateId).map(h => h.projectId).filter(Boolean);
  } catch { return []; }
}

export async function showTemplateForm(existing) {
  openAgentForm();
  const form = document.getElementById('agents-template-form');
  const t = existing || { id: '', name: '', role: '', systemPrompt: '', description: '', allowedTools: [] };
  const isEdit = !!t.id;
  // Real hire status comes from rosters, not from template.hired (deprecated).
  const hiredProjects = isEdit ? await fetchHiredProjectsForTemplate(t.id) : [];
  const isHired = hiredProjects.length > 0;
  const hiredInCurrent = !!state.currentProject && hiredProjects.includes(state.currentProject);
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
      ${isEdit && !hiredInCurrent ? `<button class="action-btn secondary" onclick="hireAgent('${t.id}')">${isHired ? 'Hire here too' : 'Hire Agent'}</button>` : ''}
      ${isEdit && isHired ? `<span style="color:var(--accent);font-size:.72rem;font-family:var(--mono)" title="Rostered in: ${hiredProjects.join(', ')}">HIRED${hiredProjects.length > 1 ? ` (${hiredProjects.length})` : ''}</span>` : ''}
    </div>
  `;
}

export async function saveTemplate(existingId) {
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

export async function hireAgent(id) {
  if (!state.currentProject) {
    showHireBanner('Pick a project from the dropdown at the top of the Agents page first — hire is always a Project action.', 'error');
    return;
  }
  try {
    const r = await fetch(`${API}/api/agents/templates/${id}/hire`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ projectId: state.currentProject })
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      showHireBanner(`Hire failed (${r.status}). ${detail}`, 'error');
      return;
    }
    loadTeam();
    loadAgentTemplates();
    cancelTemplateForm();
  } catch (e) {
    showHireBanner(`Hire failed: ${e && e.message ? e.message : e}`, 'error');
  }
}

function showHireBanner(msg, kind) {
  const form = document.getElementById('agents-template-form');
  if (!form) return;
  let banner = form.querySelector('.hire-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'hire-banner';
    form.appendChild(banner);
  }
  const color = kind === 'error' ? '#ff5555' : 'var(--accent)';
  banner.style.cssText = `color:${color};font-family:var(--mono);font-size:.72rem;margin-top:12px;padding:8px;border:1px solid ${color};border-radius:4px`;
  banner.textContent = msg;
}

export async function showTemplateDetail(id) {
  try {
    const r = await fetch(`${API}/api/agents/templates`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const templates = await r.json();
    const t = templates.find(tpl => tpl.id === id);
    if (t) showTemplateForm(t);
  } catch {}
}

export async function deleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  try {
    await fetch(`${API}/api/agents/templates/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    loadAgentTemplates();
    cancelTemplateForm();
  } catch {}
}

export function cancelTemplateForm() {
  closeAgentDetail();
}

export async function spawnFromTemplate(id) {
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

window.loadAgentTemplates = loadAgentTemplates;
window.showTemplateForm = showTemplateForm;
window.saveTemplate = saveTemplate;
window.hireAgent = hireAgent;
window.showTemplateDetail = showTemplateDetail;
window.deleteTemplate = deleteTemplate;
window.cancelTemplateForm = cancelTemplateForm;
window.spawnFromTemplate = spawnFromTemplate;
