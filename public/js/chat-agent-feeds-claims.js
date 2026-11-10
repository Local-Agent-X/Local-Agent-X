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
// The chat window carries a one-line strip of the same thing for its own
// project (#other-agents-strip): the other agents working there, with a
// warning on any that is changing the same files as this chat (ADR 0007 §6).
//
// Pure HTML: workClaimsHtml(rows), otherAgentsStripHtml(rows).
// External deps: apiFetch, esc (shared.js).

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

// ── The strip in the chat window: the other agents in THIS chat's project ──

var otherAgentsRows = [];
var otherAgentsForChat = '';

function workClaimsChatId() {
  try { return (window.activeChat && window.activeChat.id) || ''; } catch (e) { return ''; }
}

function otherAgentsStripHtml(rows) {
  if (!rows || !rows.length) return '';
  var items = rows.map(function (row) {
    var area = (row.areas || [])[0];
    var title = (row.task || '') + ((row.areas || []).length ? ' — changing ' + row.areas.join(', ') : '');
    return '<span class="other-agent ' + esc(row.state) + (row.clashesWithMe ? ' clash' : '') + '" title="' + esc(title) + '">'
      + '<span class="work-claim-dot"></span>' + esc(row.displayName || row.sessionId)
      + (area ? ' <code>' + esc(area) + '</code>' : '')
      + (row.clashesWithMe ? ' <span class="other-agent-warn" title="Changing the same files as this chat">&#9888;</span>' : '')
      + '</span>';
  });
  return '<span class="other-agents-label">Also working here:</span>' + items.join('');
}

function renderOtherAgentsStrip() {
  var host = document.getElementById('other-agents-strip');
  if (!host) return;
  var html = otherAgentsStripHtml(otherAgentsRows);
  host.innerHTML = html;
  host.style.display = html ? '' : 'none';
}

async function refreshWorkClaims() {
  try {
    var chatId = workClaimsChatId();
    var res = await apiFetch('/api/work-claims' + (chatId ? '?session=' + encodeURIComponent(chatId) : ''));
    if (!res || !res.ok) return;
    var data = await res.json();
    workClaimsRows = Array.isArray(data.holders) ? data.holders : [];
    otherAgentsRows = Array.isArray(data.others) ? data.others : [];
    otherAgentsForChat = chatId;
    renderWorkClaims();
    renderOtherAgentsStrip();
  } catch (e) { /* the next tick or frame asks again */ }
}

function initWorkClaims() {
  refreshWorkClaims();
  setInterval(refreshWorkClaims, WORK_CLAIMS_REFRESH_MS);
  // Another chat was opened: its strip is a different project's.
  setInterval(function () { if (workClaimsChatId() !== otherAgentsForChat) refreshWorkClaims(); }, 1000);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWorkClaims);
  else initWorkClaims();
}
