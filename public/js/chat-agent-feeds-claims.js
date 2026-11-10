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

// A chat's own copy of its project (src/agency/chat-own-copy.ts): offered when
// another chat writes the same folder, and merged back or left from here.
var ownCopyState = null;
var ownCopyMessage = '';

function ownCopyHtml(state, message) {
  var html = '';
  if (state && state.copy) {
    html = '<span class="own-copy" title="This chat edits its own copy of the project. Nothing reaches ' + esc(state.copy.baseBranch) + ' until you merge it back.">'
      + 'Own copy &middot; <code>' + esc(state.copy.branch) + '</code></span>'
      + '<button type="button" class="own-copy-btn" onclick="ownCopyAction(\'merge\')">Merge back</button>'
      + '<button type="button" class="own-copy-btn quiet" onclick="ownCopyAction(\'leave\')" title="Drop the copy without merging. Its branch is kept if it has unmerged work.">Leave</button>';
  } else if (state && (state.sharesFolderWith || []).length) {
    html = '<span class="own-copy warn" title="Both chats edit the very same files on disk.">Same folder as ' + esc(state.sharesFolderWith.join(', ')) + '</span>'
      + '<button type="button" class="own-copy-btn" onclick="ownCopyAction(\'start\')" title="Give this chat its own copy of the project (a git worktree from the last commit). Merge it back when its work is done.">Work in own copy</button>';
  }
  if (message) html += '<span class="own-copy-msg">' + esc(message) + '</span>';
  return html;
}

async function ownCopyAction(action) {
  var chatId = workClaimsChatId();
  if (!chatId) return;
  ownCopyMessage = action === 'merge' ? 'Merging…' : '';
  renderOtherAgentsStrip();
  try {
    var res = await apiFetch('/api/work-claims/own-copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: chatId, action: action }),
    });
    var data = await res.json();
    if (!res.ok) ownCopyMessage = data.error || 'That did not work.';
    else if (action === 'merge') ownCopyMessage = 'Merged ' + (data.files || 0) + ' file(s)' + (data.overlapNote || '') + '.';
    else if (action === 'leave') ownCopyMessage = data.branchKept ? 'Left. Unmerged work is kept on branch ' + data.branchKept + '.' : 'Left.';
    else ownCopyMessage = 'This chat now works in its own copy.';
  } catch (e) { ownCopyMessage = 'Could not reach the server.'; }
  await refreshWorkClaims();
}

// The orchestrator role of this chat's project (src/agency/orchestrator-role.ts):
// one chat hands work to the others and settles who works where. Taken and
// released here, with the user's model preferences ("Codex for UI, Claude for
// the server") kept beside it.
var orchestratorState = null;
var orchestratorEditing = false;

function orchestratorHtml(state, editing) {
  if (!state || !state.available) return '';
  if (state.mine) {
    var html = '<span class="orchestrator-badge" title="This chat hands work to other agents and settles who works where in this project.">&#9672; Orchestrator</span>'
      + '<button type="button" class="own-copy-btn quiet" onclick="orchestratorEdit()" title="' + esc(state.routing ? 'Model preferences: ' + state.routing : 'Say which model should do what') + '">Models</button>'
      + '<button type="button" class="own-copy-btn quiet" onclick="orchestratorAction(\'release\')">Release</button>';
    if (editing) {
      html += '<input id="orchestrator-routing" class="orchestrator-routing" type="text" maxlength="1000" placeholder="e.g. Codex for UI, Claude for the server, Grok for research" value="' + esc(state.routing || '') + '"'
        + ' onkeydown="if(event.key===\'Enter\')orchestratorSaveRouting()"/>'
        + '<button type="button" class="own-copy-btn" onclick="orchestratorSaveRouting()">Save</button>';
    }
    return html;
  }
  if (state.heldBy) return '<span class="orchestrator-badge other" title="That chat hands out the work in this project.">&#9672; Orchestrator: ' + esc(state.heldBy) + '</span>';
  return '<button type="button" class="own-copy-btn quiet" onclick="orchestratorAction(\'take\')" title="Make this chat the orchestrator of its project: it hands work to other agents, each on the model you choose, and settles who works where without asking you each time.">&#9672; Orchestrate</button>';
}

async function orchestratorPost(payload) {
  var chatId = workClaimsChatId();
  if (!chatId) return;
  payload.sessionId = chatId;
  try {
    var res = await apiFetch('/api/work-claims/orchestrator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { var data = await res.json(); ownCopyMessage = data.error || 'That did not work.'; }
  } catch (e) { ownCopyMessage = 'Could not reach the server.'; }
  await refreshWorkClaims();
}

function orchestratorAction(action) {
  orchestratorEditing = false;
  return orchestratorPost({ action: action });
}

function orchestratorEdit() {
  orchestratorEditing = !orchestratorEditing;
  renderOtherAgentsStrip();
  var input = document.getElementById('orchestrator-routing');
  if (input) input.focus();
}

function orchestratorSaveRouting() {
  var input = document.getElementById('orchestrator-routing');
  orchestratorEditing = false;
  return orchestratorPost({ action: 'take', routing: input ? input.value : '' });
}

function renderOtherAgentsStrip() {
  var host = document.getElementById('other-agents-strip');
  if (!host) return;
  // Typing the model preferences: a refresh must not wipe the field.
  var typing = document.getElementById('orchestrator-routing');
  if (typing && document.activeElement === typing && orchestratorEditing) return;
  var html = otherAgentsStripHtml(otherAgentsRows) + ownCopyHtml(ownCopyState, ownCopyMessage) + orchestratorHtml(orchestratorState, orchestratorEditing);
  host.innerHTML = html;
  host.style.display = html ? '' : 'none';
  // The tile grid marks the orchestrator's pane and a pane in the same files (chat-tiles.js).
  try { if (window.laxChatTiles) window.laxChatTiles.onClaimsChanged(); } catch (e) { /* the grid repaints on its next event */ }
}

async function refreshWorkClaims() {
  try {
    var chatId = workClaimsChatId();
    var res = await apiFetch('/api/work-claims' + (chatId ? '?session=' + encodeURIComponent(chatId) : ''));
    if (!res || !res.ok) return;
    var data = await res.json();
    workClaimsRows = Array.isArray(data.holders) ? data.holders : [];
    otherAgentsRows = Array.isArray(data.others) ? data.others : [];
    ownCopyState = data.ownCopy || null;
    orchestratorState = data.orchestrator || null;
    if (chatId !== otherAgentsForChat) { ownCopyMessage = ''; orchestratorEditing = false; }
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
