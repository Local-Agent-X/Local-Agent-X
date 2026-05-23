// Issues tab: ticket-style task list with status, priority, comments. Issues
// can be assigned to a hired agent (assignee is just the agent id string)
// and become the surfaced work-queue for that agent.

import { esc, timeAgo } from './helpers.js';
import { openAgentPanel, openAgentForm, closeAgentDetail } from './panel.js';
import { cancelTemplateForm } from './templates.js';

export async function loadIssues() {
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

export async function showIssueDetail(id) {
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

export async function updateIssueStatus(id, status) {
  try {
    await fetch(`${API}/api/issues/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ status })
    });
    loadIssues();
  } catch {}
}

export async function addIssueComment(id) {
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

export async function deleteIssue(id) {
  if (!confirm('Delete this issue?')) return;
  try {
    await fetch(`${API}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    loadIssues();
    closeAgentDetail();
  } catch {}
}

export function showIssueForm(assignee) {
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

export async function createIssue() {
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

window.loadIssues = loadIssues;
window.showIssueDetail = showIssueDetail;
window.updateIssueStatus = updateIssueStatus;
window.addIssueComment = addIssueComment;
window.deleteIssue = deleteIssue;
window.showIssueForm = showIssueForm;
window.createIssue = createIssue;
