// Slide-out detail panel show/hide. Two modes — `view` for read-only detail
// (showHiredAgent, showIssueDetail, showAgentDetail) and `form` for the
// editable template/issue/project forms. Both share the same overlay so
// clicking outside dismisses either.

export function openAgentPanel() {
  const overlay = document.getElementById('agents-detail-overlay');
  const panel = document.getElementById('agents-detail-panel');
  const detail = document.getElementById('agents-detail-view');
  const form = document.getElementById('agents-template-form');
  if (overlay) overlay.style.display = '';
  if (panel) panel.style.display = '';
  if (detail) detail.style.display = '';
  if (form) form.style.display = 'none';
}

export function openAgentForm() {
  const overlay = document.getElementById('agents-detail-overlay');
  const panel = document.getElementById('agents-detail-panel');
  const detail = document.getElementById('agents-detail-view');
  const form = document.getElementById('agents-template-form');
  if (overlay) overlay.style.display = '';
  if (panel) panel.style.display = '';
  if (detail) detail.style.display = 'none';
  if (form) form.style.display = '';
}

export function closeAgentDetail() {
  const overlay = document.getElementById('agents-detail-overlay');
  const panel = document.getElementById('agents-detail-panel');
  if (overlay) overlay.style.display = 'none';
  if (panel) panel.style.display = 'none';
}

window.openAgentPanel = openAgentPanel;
window.openAgentForm = openAgentForm;
window.closeAgentDetail = closeAgentDetail;
