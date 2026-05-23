// History tab: completed (and currently-running) agent runs. Auto-refreshes
// every 3s while any run is live so the elapsed counter ticks; full detail
// panel shows the task, tools used, result/error, and parent linkage for
// runs spawned by another agent.

import { esc, timeAgo, formatDuration } from './helpers.js';
import { openAgentPanel, closeAgentDetail } from './panel.js';

export async function loadAgentHistory() {
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
    list.innerHTML = runs.map(r => {
      const live = r.status === 'working';
      const elapsed = live ? Date.now() - r.startedAt : (r.completedAt - r.startedAt);
      const durationLabel = live ? `running ${formatDuration(elapsed)}` : formatDuration(elapsed);
      return `
      <div class="agent-history-item ${r.status}" onclick="showAgentDetail('${r.id}')">
        <div class="agent-history-header">
          <span class="agent-role-badge">${esc(r.role)}</span>
          <span class="agent-status-dot ${r.status}"></span>
        </div>
        <div class="agent-history-name">${esc(r.name)}${live ? ' <span style="font-size:.6rem;color:var(--accent);margin-left:6px">LIVE</span>' : ''}</div>
        <div class="agent-history-task">${esc((r.task || '').slice(0, 80))}</div>
        <div class="agent-history-meta">
          <span>${timeAgo(r.startedAt)}</span>
          <span>${r.toolsUsed?.length || 0} tools</span>
          <span>${durationLabel}</span>
        </div>
      </div>
    `;
    }).join('');
    // Auto-refresh while any run is live so the elapsed counter ticks
    // and completed runs swap from "running Xs" to a finalized duration.
    if (runs.some(r => r.status === 'working')) {
      clearTimeout(window._agentHistoryRefreshTimer);
      window._agentHistoryRefreshTimer = setTimeout(() => loadAgentHistory(), 3000);
    }
  } catch { list.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">Failed to load</div>'; }
}

export async function showAgentDetail(id) {
  openAgentPanel();
  const detail = document.getElementById('agents-detail-view');
  try {
    const r = await fetch(`${API}/api/agents/history/${id}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const run = await r.json();
    if (!detail) return;
    const statusColor = run.status === 'succeeded' ? 'var(--accent)' : run.status === 'failed' ? 'var(--danger)' : 'var(--warn)';
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

export async function deleteAgentRun(id) {
  if (!confirm('Delete this agent run?')) return;
  try {
    await fetch(`${API}/api/agents/history/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    loadAgentHistory();
    closeAgentDetail();
  } catch {}
}

window.loadAgentHistory = loadAgentHistory;
window.showAgentDetail = showAgentDetail;
window.deleteAgentRun = deleteAgentRun;
