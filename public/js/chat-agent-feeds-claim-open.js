// ── Opening an agent from the WORKING ON strip or the chat window's pill ──
//
// A row in either list (chat-agent-feeds-claims.js) opens what there is to see
// of that agent:
//   - a worker: its row in the Agents tab's job list, detail open, scrolled
//     into view. "This chat" lists only the jobs this chat started, so the
//     switch moves to All chats when the row is hidden there. A worker this
//     window has no record of (it started while the page wasn't listening) is
//     asked for once with a workers snapshot, then opened when it lands.
//   - a chat: that chat.
// When there is nothing to open, the inbox says so: a row that looks like a
// card never swallows a click.
//
// Pure: claimOpenTarget(sessionId, opId, feeds, isChat).
// External deps at call time: agentFeedsData, visibleAgentFeeds,
// setAgentFeedsScope, jobsViewState, isTerminalStatus, _renderAgentFeedsList,
// toggleAgentFeeds, agentFeedsOpen, toggleAgentPhase, switchSidePanelTab,
// agentFeedIsChat, selectChat, noteWorkersSnapshotAsked, addNotification,
// agentsPanelOpen / renderOtherAgentsStrip (the pill's panel).

var CLAIM_SNAPSHOT_WAIT_MS = 1500;

// Pure: what a click on a row opens.
function claimOpenTarget(sessionId, opId, feeds, isChat) {
  if (opId && feeds && feeds[opId]) return { kind: 'job', id: opId };
  if (sessionId && isChat(sessionId)) return { kind: 'chat', id: sessionId };
  if (opId) return { kind: 'ask', id: opId };
  return { kind: 'none' };
}

function claimRowSelector(id) {
  var safe = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : String(id).replace(/["\\]/g, '\\$&');
  return '#agent-feeds-list [data-agent-row="' + safe + '"]';
}

function openClaimJob(id) {
  var rec = agentFeedsData[id];
  if (!rec) return false;
  if (typeof visibleAgentFeeds === 'function' && !visibleAgentFeeds()[id]) setAgentFeedsScope('all');
  if (isTerminalStatus(rec.status)) jobsViewState.finishedOpen = true;
  jobsViewState.expanded[id] = 1;
  if (!agentFeedsOpen) toggleAgentFeeds();
  if (typeof switchSidePanelTab === 'function') switchSidePanelTab('agents');
  _renderAgentFeedsList();
  var row = document.querySelector(claimRowSelector(id));
  if (!row) return true;
  var phase = row.closest('.job-phase');
  if (phase && !phase.classList.contains('open')) toggleAgentPhase(phase.getAttribute('data-phase-key'));
  if (row.scrollIntoView) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return true;
}

function claimOpenFailed(name) {
  var text = 'Nothing to open for ' + name + ': this window has no record of its work.';
  if (typeof addNotification === 'function') addNotification(text, 'info');
}

// A worker the page never heard of: ask the server for every live worker
// (reconcileAgentFeeds draws the missing ones), then try once more.
function askThenOpenClaimJob(id, name) {
  if (typeof noteWorkersSnapshotAsked === 'function') noteWorkersSnapshotAsked();
  var asked = typeof window.sendChatWsControl === 'function' && window.sendChatWsControl({ type: 'workers_list' });
  setTimeout(function () { if (!openClaimJob(id)) claimOpenFailed(name); }, asked ? CLAIM_SNAPSHOT_WAIT_MS : 0);
}

function openWorkClaim(el) {
  var sessionId = el.getAttribute('data-claim-open') || '';
  var opId = el.getAttribute('data-claim-op') || '';
  var name = el.getAttribute('data-claim-name') || sessionId;
  // The pill's panel closes behind the click, as on any other choice in it.
  if (typeof agentsPanelOpen !== 'undefined' && agentsPanelOpen) { agentsPanelOpen = false; renderOtherAgentsStrip(); }
  var target = claimOpenTarget(sessionId, opId, agentFeedsData, agentFeedIsChat);
  if (target.kind === 'job') openClaimJob(target.id);
  else if (target.kind === 'chat') selectChat(target.id);
  else if (target.kind === 'ask') askThenOpenClaimJob(target.id, name);
  else claimOpenFailed(name);
}

// Capture phase: the pill's panel stops a click's propagation so it stays
// open, which would hide its rows from a bubbling listener.
if (typeof document !== 'undefined') {
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-claim-open]') : null;
    if (!el) return;
    e.stopPropagation();
    openWorkClaim(el);
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var el = e.target && e.target.closest ? e.target.closest('[data-claim-open]') : null;
    if (!el) return;
    e.preventDefault();
    openWorkClaim(el);
  });
}
