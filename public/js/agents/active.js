// Active Agents tab: list of currently-running agent runs. Clicking through
// reuses showAgentDetail from history.js (window-resolved at runtime, so
// no import needed — keeps this tab a pure render-from-fetch).

import { esc, formatDuration } from './helpers.js';

export async function loadActiveAgents() {
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

window.loadActiveAgents = loadActiveAgents;
