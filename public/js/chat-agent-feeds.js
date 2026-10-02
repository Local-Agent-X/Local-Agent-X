// ── Agent Feeds (Background tasks) ──
//
// Right-rail AGENTS panel: one list of every background op the server
// reports — jobs (a root op with the workers it spawned, as phase tables),
// single tasks, live ambient dream/mission ops, and a Finished drawer.
// Background-op events (`bg_op_queued/started/progress/completed`) flow in
// from chat-ws-handler-bg-ops.js.
//
// Layout HTML:   chat-agent-feeds-jobs.js (pure)
// Detail HTML:   chat-agent-feeds-render.js (pure; the embedded card)
// Controls:      chat-agent-feeds-actions.js
// 1s sync tick:  chat-agent-feeds-sync.js (loads after this file)
// Auto-open:     chat-agent-feeds-autoopen.js (loads BEFORE this file;
//                owns agentFeedsOpen / agentFeedsData / agentFeedsAutoOpen)
//
// External deps from chat.js / shared.js: window.esc, window.apiPost,
// window.Spring, window.sendChatWsControl(p), sendMessage.

// What the user has opened. Session-scoped, never persisted; read by
// renderBackgroundTasks so it survives the full innerHTML rebuilds below.
//   expanded[id]   — a row's or task's detail is open
//   phaseOpen[key] — a phase table the user toggled (else: open while live)
var jobsViewState = { expanded: {}, phaseOpen: {}, ambientOpen: false, finishedOpen: false };

// Ids that have played their entrance animation, so a rebuild on a progress
// tick never re-animates a visible job.
var animatedCardIds = {};

function toggleAgentFeeds() {
  var panel = document.getElementById('agent-feeds');
  if (!panel) return;
  agentFeedsOpen = !agentFeedsOpen;
  panel.style.transition = 'none';
  if (agentFeedsOpen) {
    panel.classList.remove('collapsed');
    panel.classList.add('active');
    // Body class drives the open-state styling of the top-bar toggles
    // (#dtb-agents-toggle / #sidebar-agents-btn accent highlight).
    document.body.classList.add('agents-panel-open');
    panel.style.overflow = 'hidden';
    // Desktop: open to the current tab's persisted or responsive default width,
    // and pin width+minWidth inline in onDone so the final state wins over
    // the CSS .agent-feeds.active fallback in every path — including
    // reduced-motion (safeAnimate skips onUpdate) and a width < the CSS min-width.
    // Mobile: the panel is a fixed 300px overlay driven by CSS (:1036). Never pin
    // the persisted desktop width there — cross-device shared localStorage means
    // it can be up to 720 and would cover the whole phone screen with no handle
    // to reset (handle is display:none on mobile). Animate to the mobile width,
    // then CLEAR the inline width in onDone so the CSS 300px rule drives at rest.
    var mobile = agentFeedsIsMobile();
    var openW = mobile ? AGENT_FEEDS_MOBILE : getAgentFeedsWidth();
    Spring.animate(panel, 'width', openW, { from: 0, preset: 'stiff', unit: 'px', onUpdate: function(v) { panel.style.minWidth = v + 'px'; }, onDone: function() { panel.style.overflow = 'visible'; panel.style.transition = ''; if (mobile) { panel.style.width = ''; panel.style.minWidth = ''; } else { panel.style.width = openW + 'px'; panel.style.minWidth = openW + 'px'; } } });
    if (typeof refreshSideButtons === 'function') refreshSideButtons();
  } else {
    // Drop the body class SYNCHRONOUSLY, before the refresh below reads it —
    // it used to be cleared in the spring's onDone, so refreshSideButtons()
    // saw the still-open class and left the toggle accented + titled "Hide"
    // after the panel had been closed. Nothing about this class depends on the
    // animation: it only drives the top-bar toggle's open styling, which should
    // release the moment the user clicks, not 300ms later.
    document.body.classList.remove('agents-panel-open');
    // Collapse from the current width (mobile overlay = 300, else persisted).
    Spring.animate(panel, 'width', 0, { from: agentFeedsIsMobile() ? AGENT_FEEDS_MOBILE : getAgentFeedsWidth(), preset: 'stiff', unit: 'px', onUpdate: function(v) { panel.style.minWidth = v + 'px'; }, onDone: function() { panel.classList.remove('active'); panel.classList.add('collapsed'); panel.style.transition = ''; panel.style.width = ''; panel.style.minWidth = ''; } });
    if (typeof refreshSideButtons === 'function') refreshSideButtons();
  }
}

// Right-rail width (drag-to-resize + persist) lives in chat-agent-feeds-resize.js.

function updateAgentFeeds(agents) {
  if (!agents || !Array.isArray(agents)) return;
  agentFeedsData = {};
  for (var i = 0; i < agents.length; i++) {
    agentFeedsData[agents[i].id] = agents[i];
  }
  _renderAgentFeedsList();
}

function addAgentFeed(agent) {
  if (!agent || !agent.id) return;
  var existing = agentFeedsData[agent.id];
  if (existing) {
    // Idempotent merge on the "ensure card exists" path: pick up new
    // identity/status/result fields, but NEVER touch output / streamText —
    // those are owned by the progress / stream handlers and have appended
    // history (a completion-only re-add used to wipe every turn line).
    if (agent.status) _setAgentStatus(existing, agent.status);
    if (agent.name && existing.name !== agent.name) {
      // Only upgrade a generic "Worker: op_…" name to a real one, never the reverse.
      if (!existing.name || /^Worker: op_/.test(existing.name)) existing.name = agent.name;
    }
    if (agent.role && !existing.role) existing.role = agent.role;
    if (agent.resultUrl) existing.resultUrl = agent.resultUrl;
    if (agent.reportPath && !existing.reportPath) existing.reportPath = agent.reportPath;
    // Lineage, type and start are set-once so a re-broadcast never clobbers them.
    if (agent.parentOpId && !existing.parentOpId) existing.parentOpId = agent.parentOpId;
    if (agent.type && !existing.type) existing.type = agent.type;
    if (agent.startedAt && !existing.startedAt) existing.startedAt = agent.startedAt;
    if (agent.sessionId && !existing.sessionId) existing.sessionId = agent.sessionId;
  } else {
    agentFeedsData[agent.id] = agent;
    if (agent.status) _setAgentStatus(agent, agent.status);
  }
  // Honor the auto-open preference: the record lands either way, only the
  // open animation is suppressed when AUTO is off.
  if (agentFeedsAutoOpen && !agentFeedsOpen) toggleAgentFeeds();
  _renderAgentFeedsList();
}

// Status is the one field that moves a record between sections (live → the
// Finished drawer), so it also stamps the end time the Time column needs.
function _setAgentStatus(rec, status) {
  rec.status = status;
  if (isTerminalStatus(status) && !rec.endedAt) rec.endedAt = Date.now();
}

function updateAgentFeed(agentId, update) {
  var existing = agentFeedsData[agentId];
  var statusChanged = false;
  if (!existing) {
    agentFeedsData[agentId] = update;
    existing = update;
    if (update.status) _setAgentStatus(existing, update.status);
    statusChanged = true;
  } else {
    if (update.status && update.status !== existing.status) { _setAgentStatus(existing, update.status); statusChanged = true; }
    // Two streams kept separate so the detail renders them like main chat:
    //   streamText — the worker's LLM text deltas (worker_stream events)
    //   output     — tool-call / lifecycle traces (bg_op_progress, queued,
    //                started, completed)
    if (update.streamText) existing.streamText = (existing.streamText || '') + update.streamText;
    if (update.output)     existing.output     = (existing.output     || '') + update.output;
    if (update.name) existing.name = update.name;
    if (update.role) existing.role = update.role;
    if (update.resultUrl) existing.resultUrl = update.resultUrl;
    // sessionId + lastActivityMs feed the reconnect replay in chat-ws.js and
    // the stall badge: sessionId is set-once, lastActivityMs bumps per signal.
    if (update.sessionId && !existing.sessionId) existing.sessionId = update.sessionId;
    if (update.lastActivityMs) existing.lastActivityMs = update.lastActivityMs;
    if (update.parentOpId && !existing.parentOpId) existing.parentOpId = update.parentOpId;
    if (update.type && !existing.type) existing.type = update.type;
    if (update.startedAt && !existing.startedAt) existing.startedAt = update.startedAt;
    if (update.model && !existing.model) existing.model = update.model;
    if (update.totalTokens != null) existing.totalTokens = update.totalTokens;
  }
  var card = document.getElementById('agent-card-' + agentId);
  // A status change can move the record to another section or swap the
  // row's mark and controls, so it is a rebuild; everything else is a
  // targeted write that leaves the user's scroll and open details alone.
  if (!card || statusChanged) { _renderAgentFeedsList(); return; }
  if (update.streamText) {
    var textEl = card.querySelector('.worker-text');
    if (textEl) {
      // Only auto-scroll while the user is pinned near the bottom; a reader
      // who scrolled up keeps their place.
      var atBottom = (textEl.scrollHeight - textEl.scrollTop - textEl.clientHeight) < 40;
      textEl.textContent = existing.streamText || '';
      if (atBottom) textEl.scrollTop = textEl.scrollHeight;
    }
  }
  if (update.output) {
    var toolsBody = card.querySelector('.worker-tools-body');
    if (toolsBody) {
      var atBottomT = (toolsBody.scrollHeight - toolsBody.scrollTop - toolsBody.clientHeight) < 40;
      toolsBody.textContent = existing.output || '';
      if (atBottomT) toolsBody.scrollTop = toolsBody.scrollHeight;
    }
    var countEl = card.querySelector('.worker-tools-count');
    var lines = (existing.output || '').split('\n').filter(function(l) { return l.trim().length > 0; });
    if (countEl) countEl.textContent = String(lines.length);
    // Always-visible one-line preview of the latest activity, so a collapsed
    // detail still shows motion.
    var latestEl = card.querySelector('.worker-latest');
    if (latestEl && lines.length > 0) latestEl.textContent = lines[lines.length - 1];
  }
  if (update.totalTokens != null) {
    var tokCntEl = card.querySelector('.worker-token-count');
    if (tokCntEl) tokCntEl.textContent = formatTokens(existing.totalTokens) + ' tok';
    var tokFillEl = card.querySelector('.worker-token-bar-fill');
    if (tokFillEl) tokFillEl.style.width = tokenBarFillPct(existing.totalTokens) + '%';
  }
  if (update.totalTokens != null || update.model) syncAgentRowCells(agentId, existing, Date.now());
  // Build_app and other URL-producing ops set resultUrl on completion; the
  // markup (incl. the ?token= auth append) comes from resultLinkHtml, the one
  // chokepoint shared with the render path.
  if (update.resultUrl) {
    var linkEl = card.querySelector('.agent-feed-result-link');
    if (linkEl) {
      linkEl.innerHTML = resultLinkHtml(update.resultUrl);
      linkEl.style.display = 'block';
    }
  }
}

function removeAgentFeed(agentId) {
  delete agentFeedsData[agentId];
  delete animatedCardIds[agentId];
  delete jobsViewState.expanded[agentId];
  _renderAgentFeedsList();
}

// The trash icon on the Finished drawer: drop every record the drawer
// lists — a finished job with all its workers, a finished task, a finished
// ambient op. Live records are never touched.
function clearFinishedAgentFeeds() {
  var parts = partitionAmbient(agentFeedsData);
  var tree = buildAgentFeedTree(parts.main);
  var ids = [];
  for (var i = 0; i < tree.length; i++) if (jobIsFinished(tree[i], agentFeedsData)) ids = ids.concat(jobCollectIds(tree[i]));
  var amb = Object.keys(parts.ambient);
  for (var a = 0; a < amb.length; a++) if (isTerminalStatus(parts.ambient[amb[a]].status)) ids.push(amb[a]);
  for (var k = 0; k < ids.length; k++) { delete agentFeedsData[ids[k]]; delete animatedCardIds[ids[k]]; delete jobsViewState.expanded[ids[k]]; }
  _renderAgentFeedsList();
}

// Open/close a row's or task's detail in place: the detail is the next
// sibling of the element carrying data-agent-row.
function toggleAgentRowDetail(id) {
  var open = !jobsViewState.expanded[id];
  if (open) jobsViewState.expanded[id] = 1; else delete jobsViewState.expanded[id];
  var els = document.querySelectorAll('[data-agent-row="' + id + '"]');
  for (var i = 0; i < els.length; i++) {
    els[i].classList.toggle('open', open);
    var detail = els[i].nextElementSibling;
    if (detail && detail.classList.contains('job-row-detail')) detail.style.display = open ? 'block' : 'none';
  }
}

function _toggleSection(el, bodySelector, open) {
  if (!el) return;
  el.classList.toggle('open', open);
  var body = el.querySelector(bodySelector);
  if (body) body.style.display = open ? 'block' : 'none';
  var chev = el.querySelector('.job-phase-chevron');
  if (chev) chev.innerHTML = open ? '&#9662;' : '&#9656;';
}

function toggleAgentPhase(key) {
  var phase = document.querySelector('.job-phase[data-phase-key="' + key.replace(/"/g, '\\"') + '"]');
  var open = !(phase && phase.classList.contains('open'));
  jobsViewState.phaseOpen[key] = open;
  _toggleSection(phase, '.job-table', open);
}

function toggleAgentAmbient() {
  jobsViewState.ambientOpen = !jobsViewState.ambientOpen;
  _toggleSection(document.querySelector('.job-ambient'), '.job-ambient-list', jobsViewState.ambientOpen);
}

function toggleAgentFinished() {
  jobsViewState.finishedOpen = !jobsViewState.finishedOpen;
  _toggleSection(document.querySelector('.job-finished'), '.job-finished-list', jobsViewState.finishedOpen);
}

function _renderAgentFeedsList() {
  var list = document.getElementById('agent-feeds-list');
  if (!list) return;
  list.innerHTML = renderBackgroundTasks(agentFeedsData, jobsViewState, Date.now());
  // Animate only jobs and tasks that are new this rebuild.
  var fresh = Array.from(list.querySelectorAll('.job, .job-task')).filter(function(el) {
    var key = el.getAttribute('data-job-id') || el.getAttribute('data-agent-row');
    if (!key || animatedCardIds[key]) return false;
    animatedCardIds[key] = 1;
    return true;
  });
  if (fresh.length && typeof Spring !== 'undefined') Spring.staggerIn(fresh, { delay: 50, preset: 'stiff' });
  _updateAgentCount();
}

// The tab badge counts what is still running; finished work sits in the drawer.
function _updateAgentCount() {
  var count = 0;
  var ids = Object.keys(agentFeedsData);
  for (var i = 0; i < ids.length; i++) if (!isTerminalStatus(agentFeedsData[ids[i]].status)) count++;
  var el = document.getElementById('agent-count');
  if (el) el.textContent = String(count);
}
