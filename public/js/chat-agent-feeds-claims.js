// ── Agents panel: who is working on what ──
//
// A strip at the top of the AGENTS tab listing the agents working in the same
// files right now (ADR 0007 §4), and the files each live worker is changing,
// which its row in the list below shows (workClaimAreasByOp). The strip listed
// every agent, a second row for each worker the list already showed
// (2026-11-25). Read from GET /api/work-claims
// (src/routes/agents/work-claims.ts); re-read on a `work_claims_changed` frame
// and on a timer, since a state changes with time alone (working → between
// messages → finished, when it leaves the strip).
//
// The chat window carries the same thing for its own project (ADR 0007 §6): a
// pill in the toolbar's corner (#other-agents-strip) that opens a panel of the
// other agents working there, and a banner (#agents-clash) only when one of
// them is in this chat's files or folder.
//
// A row in either list opens that agent's work: chat-agent-feeds-claim-open.js.
//
// Pure HTML: workClaimsHtml(rows), otherAgentsStripHtml(rows, own, orch, open),
// agentsClashHtml(clash, message).
// External deps: apiFetch, esc (shared.js).

var WORK_CLAIMS_REFRESH_MS = 15000;
var workClaimsRows = [];
// The chat on screen and the agents it started (the route's `mine`).
var workClaimsMine = [];

var WORK_CLAIM_STATE = { active: 'working now', idle: 'between messages' };

// What a click on a row opens (chat-agent-feeds-claim-open.js): the worker's
// job detail, or the chat.
function workClaimOpenAttrs(row) {
  var what = row.kind === 'chat' ? 'Open this chat' : 'Show what this agent is doing';
  return ' role="button" tabindex="0" title="' + what + '" data-claim-open="' + esc(row.sessionId || '') + '"'
    + ' data-claim-op="' + esc(row.opId || '') + '" data-claim-name="' + esc(row.displayName || row.sessionId || '') + '"';
}

function workClaimRowHtml(row) {
  var areas = (row.areas || []).map(function (a) { return '<code>' + esc(a) + '</code>'; }).join(' ');
  var clash = (row.clashesWith || []).length
    ? '<div class="work-claim-clash" title="Both are changing the same files">&#9888; same files as ' + esc(row.clashesWith.join(', ')) + '</div>'
    : '';
  return '<div class="work-claim-row ' + esc(row.state) + (clash ? ' clash' : '') + '"' + workClaimOpenAttrs(row) + '>'
    + '<div class="work-claim-head"><span class="work-claim-dot"></span>'
    + '<span class="work-claim-name">' + esc(row.displayName || row.sessionId) + '</span>'
    + '<span class="work-claim-meta">' + esc(row.kind) + ' · ' + esc(WORK_CLAIM_STATE[row.state] || row.state) + ' · ' + esc(row.folder || '') + '</span></div>'
    + (row.task ? '<div class="work-claim-task">' + esc(row.task) + '</div>' : '')
    + (areas ? '<div class="work-claim-areas">' + areas + '</div>' : '')
    + clash + '</div>';
}

function workClaimsHtml(rows) {
  var clashing = (rows || []).filter(function (r) { return (r.clashesWith || []).length > 0; });
  if (!clashing.length) return '';
  return '<div class="work-claims-title">SAME FILES</div>' + clashing.map(workClaimRowHtml).join('');
}

// The files each worker is changing, by its op id (the id its row in the list
// has, chat-agent-feeds-claim-open.js), for renderBackgroundTasks.
function workClaimAreasByOp() {
  var out = {};
  for (var i = 0; i < workClaimsRows.length; i++) {
    var r = workClaimsRows[i];
    if (r.kind === 'worker' && r.opId && (r.areas || []).length) out[r.opId] = r.areas;
  }
  return out;
}

// The rows the strip lists: this chat's own and the others in its project, or
// every holder with the panel on All (chat-agent-feeds-scope.js).
function shownWorkClaimRows() {
  if (typeof agentFeedsScope === 'undefined' || agentFeedsScope === 'all' || !workClaimsChatId()) return workClaimsRows;
  var seen = {}, out = [];
  workClaimsMine.concat(otherAgentsRows).forEach(function (r) {
    if (seen[r.sessionId]) return;
    seen[r.sessionId] = 1;
    out.push(r);
  });
  return out;
}

function renderWorkClaims() {
  var host = document.getElementById('work-claims');
  if (!host) return;
  var html = workClaimsHtml(shownWorkClaimRows());
  host.innerHTML = html;
  host.style.display = html ? '' : 'none';
}

// ── The strip in the chat window: the other agents in THIS chat's project ──

var otherAgentsRows = [];
var otherAgentsForChat = '';

function workClaimsChatId() {
  try { return (window.activeChat && window.activeChat.id) || ''; } catch (e) { return ''; }
}

// The strip is one pill in the toolbar's corner ("● 2 other agents here"),
// opening a panel with each agent, the own-copy and the orchestrator controls.
// Only a real clash (another agent in this chat's files or folder) earns a
// banner under the toolbar, until the user dismisses that clash.
var agentsPanelOpen = false;
var agentsClashDismissed = '';

function otherAgentRowHtml(row) {
  var areas = (row.areas || []).map(function (a) { return '<code>' + esc(a) + '</code>'; }).join(' ');
  return '<div class="other-agent ' + esc(row.state) + (row.clashesWithMe ? ' clash' : '') + '"' + workClaimOpenAttrs(row) + '>'
    + '<div class="work-claim-head"><span class="work-claim-dot"></span>'
    + '<span class="work-claim-name">' + esc(row.displayName || row.sessionId) + '</span>'
    + '<span class="work-claim-meta">' + esc(row.kind || 'chat') + ' · ' + esc(WORK_CLAIM_STATE[row.state] || row.state) + '</span></div>'
    + (row.task ? '<div class="work-claim-task" title="' + esc(row.task) + '">' + esc(row.task) + '</div>' : '')
    + (areas ? '<div class="work-claim-areas">' + areas + '</div>' : '')
    + (row.clashesWithMe ? '<div class="work-claim-clash">&#9888; changing the same files as this chat</div>' : '')
    + '</div>';
}

function agentsPillLabel(rows, own, orch) {
  if (rows.length) return rows.length + (rows.length === 1 ? ' other agent here' : ' other agents here');
  if (own && own.copy) return 'Own copy';
  if (orch && orch.mine) return 'Orchestrator';
  return '';
}

function otherAgentsStripHtml(rows, own, orch, open) {
  rows = rows || [];
  var controls = ownCopyHtml(own, '') + orchestratorHtml(orch, orchestratorEditing);
  if (!rows.length && !controls) return '';
  var clash = rows.some(function (r) { return r.clashesWithMe; }) || !!(own && !own.copy && (own.sharesFolderWith || []).length);
  var active = rows.some(function (r) { return r.state === 'active'; });
  var label = agentsPillLabel(rows, own, orch);
  var pill = '<button type="button" class="agents-pill' + (clash ? ' clash' : '') + (active ? ' active' : '') + (open ? ' open' : '') + '"'
    + ' aria-expanded="' + (open ? 'true' : 'false') + '" onclick="toggleAgentsPanel(event)" title="Agents working in this chat’s project">'
    + '<span class="work-claim-dot"></span>' + (label ? esc(label) : '&#9672;')
    + (label && orch && (orch.mine || orch.heldBy) ? ' <span class="agents-pill-orch">&#9672;</span>' : '')
    + ' <span class="agents-pill-caret">&#9662;</span></button>';
  if (!open) return pill;
  return pill + '<div class="agents-panel" role="dialog" aria-label="Agents in this project" onclick="event.stopPropagation()">'
    + '<div class="work-claims-title">IN THIS PROJECT</div>'
    + (rows.length ? rows.map(otherAgentRowHtml).join('') : '<div class="agents-panel-empty">No other agents here right now.</div>')
    + (controls ? '<div class="agents-panel-controls">' + controls + '</div>' : '')
    + '</div>';
}

// The banner: what clashes, keyed so a dismissed clash stays dismissed until
// a different one comes up. A note from an own-copy action shows here too.
function agentsClashOf(rows, own) {
  if (own && !own.copy && (own.sharesFolderWith || []).length) {
    return { key: 'folder:' + own.sharesFolderWith.slice().sort().join(','), folder: true,
      text: 'Same folder as ' + own.sharesFolderWith.join(', ') + ': both chats edit the very same files on disk.' };
  }
  var hits = (rows || []).filter(function (r) { return r.clashesWithMe; });
  if (!hits.length) return null;
  var names = hits.map(function (r) { return r.displayName || r.sessionId; });
  var areas = hits.reduce(function (a, r) { return a.concat(r.areas || []); }, []);
  return { key: 'files:' + names.slice().sort().join(','), folder: false,
    text: names.join(', ') + (hits.length === 1 ? ' is' : ' are') + ' changing the same files as this chat' + (areas.length ? ' (' + areas.join(', ') + ')' : '') + '.' };
}

function agentsClashHtml(clash, message) {
  if (message) {
    return '<span class="agents-clash-text">' + esc(message) + '</span>'
      + '<button type="button" class="own-copy-btn quiet" onclick="dismissAgentsClash(\'note\')">Dismiss</button>';
  }
  if (!clash || clash.key === agentsClashDismissed) return '';
  return '<span class="agents-clash-text">&#9888; ' + esc(clash.text) + '</span>'
    + (clash.folder
      ? '<button type="button" class="own-copy-btn" onclick="ownCopyAction(\'start\')" title="Give this chat its own copy of the project (a git worktree from the last commit). Merge it back when its work is done.">Work in own copy</button>'
      : '<button type="button" class="own-copy-btn quiet" onclick="toggleAgentsPanel(event)">Details</button>')
    + '<button type="button" class="own-copy-btn quiet" onclick="dismissAgentsClash()">Dismiss</button>';
}

function toggleAgentsPanel(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  agentsPanelOpen = !agentsPanelOpen;
  renderOtherAgentsStrip();
}

function dismissAgentsClash(what) {
  if (what === 'note') ownCopyMessage = '';
  else { var c = agentsClashOf(otherAgentsRows, ownCopyState); agentsClashDismissed = c ? c.key : ''; }
  renderOtherAgentsStrip();
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
  var html = otherAgentsStripHtml(otherAgentsRows, ownCopyState, orchestratorState, agentsPanelOpen);
  if (!html) agentsPanelOpen = false;
  host.innerHTML = html;
  host.style.display = html ? '' : 'none';
  var banner = document.getElementById('agents-clash');
  if (banner) {
    var bannerHtml = agentsClashHtml(agentsClashOf(otherAgentsRows, ownCopyState), ownCopyMessage);
    banner.innerHTML = bannerHtml;
    banner.style.display = bannerHtml ? '' : 'none';
  }
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
    workClaimsMine = Array.isArray(data.mine) ? data.mine : [];
    otherAgentsRows = Array.isArray(data.others) ? data.others : [];
    ownCopyState = data.ownCopy || null;
    orchestratorState = data.orchestrator || null;
    if (chatId !== otherAgentsForChat) { ownCopyMessage = ''; orchestratorEditing = false; agentsPanelOpen = false; agentsClashDismissed = ''; }
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
  // The panel closes on a click outside it or Escape.
  document.addEventListener('click', function () { if (agentsPanelOpen) { agentsPanelOpen = false; renderOtherAgentsStrip(); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && agentsPanelOpen) { agentsPanelOpen = false; renderOtherAgentsStrip(); } });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWorkClaims);
  else initWorkClaims();
}
