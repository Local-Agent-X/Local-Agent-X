// Agents Dashboard — default tab. Five sections: scope line, stat cards,
// running-now feed, recent activity, pending issues, templates shortcut.
// Re-renders on project switch (projects.js calls loadDashboard via the
// tabs dispatcher). All fetches are best-effort: a single section failing
// shouldn't blank the rest.

import { state } from './state.js';
import { esc, timeAgo, formatDuration } from './helpers.js';

export async function loadDashboard() {
  renderScope();
  // Fire all four sections in parallel — none depend on each other.
  loadRunning();
  loadRecent();
  loadPending();
  loadTemplatesShortcut();
}

function renderScope() {
  const el = document.getElementById('agents-dashboard-scope');
  if (!el) return;
  if (state.currentProject) {
    const sel = document.getElementById('agents-project-select');
    const name = sel?.options[sel.selectedIndex]?.text || state.currentProject;
    el.innerHTML = `Scoped to project: <strong style="color:var(--accent)">${esc(name)}</strong>`;
  } else {
    el.innerHTML = `Showing activity across <strong style="color:var(--accent)">all projects</strong> — pick one above to scope this view.`;
  }
}

async function loadRunning() {
  const list = document.getElementById('dash-running');
  const count = document.getElementById('dash-running-count');
  if (!list) return;
  try {
    const r = await fetch(`${API}/api/agents/active`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    let runs = await r.json();
    if (!Array.isArray(runs)) runs = [];
    if (state.currentProject) runs = runs.filter(a => a.projectId === state.currentProject);
    if (count) count.textContent = runs.length ? `${runs.length} active` : '';
    updateStats({ running: runs.length });
    if (runs.length === 0) {
      list.innerHTML = '<div class="dash-empty">Nothing running right now.</div>';
      return;
    }
    list.innerHTML = runs.slice(0, 6).map(a => `
      <div class="agent-history-item working" onclick="showAgentDetail('${a.id}')">
        <div class="agent-history-header">
          <span class="agent-role-badge">${esc(a.role || '')}</span>
          <span class="agent-status-dot working"></span>
        </div>
        <div class="agent-history-name">${esc(a.name || 'agent')}</div>
        <div class="agent-history-task">${esc((a.currentTask || '').slice(0, 90))}</div>
        <div class="agent-history-meta">
          <span>${formatDuration(a.elapsed || 0)}</span>
          <span>${a.tokensUsed || 0} tokens</span>
          <span>${a.progress || 0}%</span>
        </div>
      </div>
    `).join('');
  } catch {
    list.innerHTML = '<div class="dash-empty">Failed to load.</div>';
  }
}

async function loadRecent() {
  const list = document.getElementById('dash-recent');
  if (!list) return;
  try {
    const r = await fetch(`${API}/api/agents/history?limit=20`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const data = await r.json();
    let runs = data.runs || [];
    if (state.currentProject) runs = runs.filter(x => x.projectId === state.currentProject);
    const done = runs.filter(x => x.status === 'done').length;
    const errs = runs.filter(x => x.status === 'error' || x.status === 'timeout').length;
    updateStats({ recentDone: done, recentErr: errs });
    if (runs.length === 0) {
      list.innerHTML = '<div class="dash-empty">No recent runs.</div>';
      return;
    }
    list.innerHTML = runs.slice(0, 5).map(x => {
      const elapsed = x.completedAt ? (x.completedAt - x.startedAt) : (Date.now() - x.startedAt);
      return `
        <div class="agent-history-item ${x.status}" onclick="showAgentDetail('${x.id}')">
          <div class="agent-history-header">
            <span class="agent-role-badge">${esc(x.role || '')}</span>
            <span class="agent-status-dot ${x.status}"></span>
          </div>
          <div class="agent-history-name">${esc(x.name || 'agent')}</div>
          <div class="agent-history-task">${esc((x.task || '').slice(0, 90))}</div>
          <div class="agent-history-meta">
            <span>${timeAgo(x.startedAt)}</span>
            <span>${formatDuration(elapsed)}</span>
            <span>${x.toolsUsed?.length || 0} tools</span>
          </div>
        </div>`;
    }).join('');
  } catch {
    list.innerHTML = '<div class="dash-empty">Failed to load.</div>';
  }
}

async function loadPending() {
  const list = document.getElementById('dash-issues');
  if (!list) return;
  try {
    const r = await fetch(`${API}/api/issues`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    let issues = await r.json();
    if (!Array.isArray(issues)) issues = [];
    if (state.currentProject) issues = issues.filter(i => i.projectId === state.currentProject);
    const open = issues.filter(i => i.status !== 'done' && i.status !== 'closed');
    updateStats({ pending: open.length });
    if (open.length === 0) {
      list.innerHTML = '<div class="dash-empty">No pending issues.</div>';
      return;
    }
    list.innerHTML = open.slice(0, 5).map(i => `
      <div class="agent-history-item ${i.status}" onclick="showIssueDetail('${i.id}')">
        <div class="agent-history-header">
          <span style="font-family:var(--mono);font-size:.65rem;color:var(--accent)">${esc(i.id)}</span>
          <span class="agent-role-badge">${esc(i.status)}</span>
        </div>
        <div class="agent-history-name">${esc(i.title)}</div>
        <div class="agent-history-meta">
          <span>${i.assignee ? 'Assigned: ' + esc(i.assignee) : 'Unassigned'}</span>
          <span>${esc(i.priority || 'normal')}</span>
          <span>${timeAgo(i.updatedAt)}</span>
        </div>
      </div>
    `).join('');
  } catch {
    list.innerHTML = '<div class="dash-empty">Failed to load.</div>';
  }
}

async function loadTemplatesShortcut() {
  const list = document.getElementById('dash-templates');
  if (!list) return;
  try {
    const r = await fetch(`${API}/api/agents/templates`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const templates = await r.json();
    if (!Array.isArray(templates) || templates.length === 0) {
      list.innerHTML = '<div class="dash-empty">No templates yet.</div>';
      return;
    }
    updateStats({ templates: templates.length });
    list.innerHTML = templates.slice(0, 8).map(t => `
      <div class="agent-history-item" style="border-left:3px solid var(--border);text-align:center;padding:12px" onclick="showTemplateDetail('${t.id}')">
        <div style="font-size:1.6rem;margin-bottom:4px">${t.icon || '&#129302;'}</div>
        <div class="agent-history-name" style="font-size:.74rem">${esc(t.name)}</div>
        <div style="font-size:.62rem;color:var(--muted);margin-top:2px">${esc(t.role || '')}</div>
      </div>
    `).join('');
  } catch {
    list.innerHTML = '<div class="dash-empty">Failed to load.</div>';
  }
}

// Stat cards are populated incrementally as sections resolve — keeps each
// number authoritative without needing one giant Promise.all that gets
// blocked by a single slow endpoint.
const stats = { running: null, recentDone: null, recentErr: null, pending: null, templates: null };
function updateStats(patch) {
  Object.assign(stats, patch);
  const el = document.getElementById('agents-dash-stats');
  if (!el) return;
  const cell = (label, value, sub) => `
    <div class="dash-stat">
      <div class="dash-stat-label">${label}</div>
      <div class="dash-stat-value">${value ?? '—'}</div>
      ${sub ? `<div class="dash-stat-sub">${sub}</div>` : ''}
    </div>`;
  el.innerHTML = [
    cell('Running', stats.running),
    cell('Pending issues', stats.pending),
    cell('Recent runs', stats.recentDone !== null ? (stats.recentDone + (stats.recentErr || 0)) : null, stats.recentErr ? `${stats.recentErr} failed` : 'last 20'),
    cell('Templates', stats.templates),
  ].join('');
}

window.loadDashboard = loadDashboard;
