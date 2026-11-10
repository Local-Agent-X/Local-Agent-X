// ── Agents panel: who is working on what ──
//
// A strip at the top of the AGENTS tab listing every agent working in a
// project right now — chats and workers alike — with its task, the files or
// folders it is changing, and a warning when two of them are in the same
// files (ADR 0007 §4). Read from GET /api/work-claims
// (src/routes/agents/work-claims.ts); re-read on a `work_claims_changed` frame
// and on a timer, since a state changes with time alone (working → between
// messages → lately).
//
// Pure HTML: workClaimsHtml(rows). External deps: apiFetch, esc (shared.js).

var WORK_CLAIMS_REFRESH_MS = 15000;
var workClaimsRows = [];

var WORK_CLAIM_STATE = { active: 'working now', idle: 'between messages', recent: 'lately' };

function workClaimRowHtml(row) {
  var areas = (row.areas || []).map(function (a) { return '<code>' + esc(a) + '</code>'; }).join(' ');
  var clash = (row.clashesWith || []).length
    ? '<div class="work-claim-clash" title="Both are changing the same files">&#9888; same files as ' + esc(row.clashesWith.join(', ')) + '</div>'
    : '';
  return '<div class="work-claim-row ' + esc(row.state) + (clash ? ' clash' : '') + '">'
    + '<div class="work-claim-head"><span class="work-claim-dot"></span>'
    + '<span class="work-claim-name">' + esc(row.displayName || row.sessionId) + '</span>'
    + '<span class="work-claim-meta">' + esc(row.kind) + ' · ' + esc(WORK_CLAIM_STATE[row.state] || row.state) + ' · ' + esc(row.folder || '') + '</span></div>'
    + (row.task ? '<div class="work-claim-task">' + esc(row.task) + '</div>' : '')
    + (areas ? '<div class="work-claim-areas">' + areas + '</div>' : '')
    + clash + '</div>';
}

function workClaimsHtml(rows) {
  if (!rows || !rows.length) return '';
  return '<div class="work-claims-title">WORKING ON</div>' + rows.map(workClaimRowHtml).join('');
}

function renderWorkClaims() {
  var host = document.getElementById('work-claims');
  if (!host) return;
  var html = workClaimsHtml(workClaimsRows);
  host.innerHTML = html;
  host.style.display = html ? '' : 'none';
}

async function refreshWorkClaims() {
  try {
    var res = await apiFetch('/api/work-claims');
    if (!res || !res.ok) return;
    var data = await res.json();
    workClaimsRows = Array.isArray(data.holders) ? data.holders : [];
    renderWorkClaims();
  } catch (e) { /* the next tick or frame asks again */ }
}

function initWorkClaims() {
  refreshWorkClaims();
  setInterval(refreshWorkClaims, WORK_CLAIMS_REFRESH_MS);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWorkClaims);
  else initWorkClaims();
}
