// ── Agent Feeds (Mission Control) ──
//
// Right-rail Agents panel — shows live worker / agent ops the supervisor
// has spawned, with per-card pause / resume / redirect / cancel /
// stay-inline controls. Background-op events (`bg_op_queued/started/
// progress/completed`) flow into here from chat-ws-handler.js.
//
// Card HTML: chat-agent-feeds-render.js
// Control handlers: chat-agent-feeds-actions.js
// Auto-open pref: chat-agent-feeds-autoopen.js (loads BEFORE this file;
//   owns agentFeedsOpen / agentFeedsData / agentFeedsAutoOpen)
//
// External deps from chat.js / shared.js:
//   - window.esc, window.apiPost      (shared.js)
//   - window.Spring                   (spring.js)
//   - window.sendChatWsControl(p)     (chat.js — wraps the chat WS send
//                                      so this module never touches WS
//                                      state directly)
//   - sendMessage                     (chat-send.js — used by Stay-inline)
//
// State (agentFeedsOpen / agentFeedsData / agentFeedsAutoOpen) is declared
// in chat-agent-feeds-autoopen.js, which loads before this file.

// Ambient cards the user has expanded (id → 1). Session-scoped, never
// persisted; read by renderAmbientRegion so a user-opened card survives the
// full innerHTML rebuilds _renderAgentFeedsList does on every add/update.
var ambientExpanded = {};

// Card ids that have already played their entrance animation. _renderAgentFeedsList
// does a full innerHTML rebuild on every add/update, and a live worker streams
// bg_op_progress constantly — so without this, staggerIn re-animated EVERY card on
// EVERY tick, which read as the card flashing. Now staggerIn runs only for cards
// whose id is new this rebuild; existing cards re-mount silently.
var animatedCardIds = {};

function toggleAgentFeeds() {
  var panel = document.getElementById('agent-feeds');
  if (!panel) return;
  agentFeedsOpen = !agentFeedsOpen;
  panel.style.transition = 'none';
  if (agentFeedsOpen) {
    panel.classList.remove('collapsed');
    panel.classList.add('active');
    panel.querySelector('.agent-feeds-toggle').innerHTML = '&#9654;';
    // Body class drives the open-state styling of the top-bar toggles
    // (#dtb-agents-toggle / #sidebar-agents-btn accent highlight).
    document.body.classList.add('agents-panel-open');
    panel.style.overflow = 'hidden';
    // Desktop: open to the user's persisted width (default 320), not a hardcoded
    // 320, and pin width+minWidth inline in onDone so the final state wins over
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
    panel.querySelector('.agent-feeds-toggle').innerHTML = '&#9664;';
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

// Right-rail width (drag-to-resize + persist) lives in the sibling
// chat-agent-feeds-resize.js, which owns getAgentFeedsWidth() (used above),
// clampAgentFeedsWidth(), the .agent-feeds-resize-handle pointer wiring, and
// the lax_agent_feeds_width localStorage key. Split out to keep this file
// under the 400-LOC source-hygiene ceiling, matching the -render / -actions /
// -autoopen sibling pattern.

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
    // Idempotent merge on the "ensure card exists" path. Old code
    // unconditionally overwrote agentFeedsData[id], which wiped
    // accumulated turn-by-turn progress when the bg_op_completed
    // handler called addAgentFeed for defense-in-depth. Symptom: live
    // worker card showed "turn 0 committed", "turn 1 committed", …,
    // then on completion collapsed to a single "task completed" line —
    // all prior thinking disappeared from the sidebar.
    //
    // Now: pick up new identity/status/result fields, but NEVER touch
    // output / streamText (those are owned by the progress / stream
    // event handlers and have appended history). Status is allowed to
    // update — completion needs to flip the badge from "working" to
    // "completed".
    if (agent.status) existing.status = agent.status;
    if (agent.name && existing.name !== agent.name) {
      // Only upgrade the name if the new one looks more informative
      // (e.g. server-side later learns the mission's friendly name
      // and re-broadcasts). Don't downgrade a real name back to a
      // generic "Worker: opId..." string.
      if (!existing.name || /^Worker: op_/.test(existing.name)) existing.name = agent.name;
    }
    if (agent.role && !existing.role) existing.role = agent.role;
    if (agent.resultUrl) existing.resultUrl = agent.resultUrl;
    if (agent.reportPath && !existing.reportPath) existing.reportPath = agent.reportPath;
    // parentOpId (C6 run-lineage): set-once, like sessionId. Carried on
    // bg_op_queued / bg_op_started so the panel can nest workers under the
    // op that spawned them. Never downgrade a known parent back to none.
    if (agent.parentOpId && !existing.parentOpId) existing.parentOpId = agent.parentOpId;
    if (agent.type && !existing.type) existing.type = agent.type; // C8 per-type icon: set-once
  } else {
    agentFeedsData[agent.id] = agent;
  }
  // Honor the user's auto-open preference. Card is still added to the
  // panel either way; just the open animation is suppressed when AUTO
  // is off, so nothing surprises the user mid-task.
  if (agentFeedsAutoOpen && !agentFeedsOpen) toggleAgentFeeds();
  _renderAgentFeedsList();
}

function updateAgentFeed(agentId, update) {
  var existing = agentFeedsData[agentId];
  if (!existing) {
    agentFeedsData[agentId] = update;
    existing = update;
  } else {
    if (update.status) existing.status = update.status;
    // Two streams kept separate so the worker card body can render them
    // like main chat: text bubble on top, collapsible tools group below.
    //   streamText  — worker's LLM text deltas (worker_stream events)
    //   output      — tool-call / lifecycle traces (bg_op_progress, queued,
    //                 started, completed); also accepts legacy callers.
    if (update.streamText) existing.streamText = (existing.streamText || '') + update.streamText;
    if (update.output)     existing.output     = (existing.output     || '') + update.output;
    if (update.name) existing.name = update.name;
    if (update.role) existing.role = update.role;
    if (update.resultUrl) existing.resultUrl = update.resultUrl;
    // sessionId + lastActivityMs are read by the worker stuck-stream
    // watchdog in chat-ws.js — bump them so a steadily-progressing
    // worker is never flagged as stuck. Once set (on bg_op_started),
    // sessionId never changes; lastActivityMs bumps on every signal
    // event (worker_stream, bg_op_progress).
    if (update.sessionId && !existing.sessionId) existing.sessionId = update.sessionId;
    if (update.lastActivityMs) existing.lastActivityMs = update.lastActivityMs;
    // parentOpId (C6 run-lineage): set-once. See addAgentFeed above.
    if (update.parentOpId && !existing.parentOpId) existing.parentOpId = update.parentOpId;
    if (update.type && !existing.type) existing.type = update.type; // C8 per-type icon: set-once
    if (update.totalTokens != null) existing.totalTokens = update.totalTokens; // running token total → card meter (Part B)
  }
  var card = document.getElementById('agent-card-' + agentId);
  if (card) {
    // C8: fold survives the className rewrite (foldedAfterUpdate: render sibling).
    var nowTerminal = isTerminalStatus(existing.status);
    var folded = foldedAfterUpdate(nowTerminal, card.getAttribute('data-terminal') === '1', card.classList.contains('folded'));
    // `ambient` must survive the rewrite — it's what lets the header-click
    // fold toggle work at any status. Keep ambientExpanded in sync when
    // first-terminal auto-folds the card, so the next dock rebuild agrees.
    var ambient = isAmbientType(existing.type);
    if (ambient && folded) delete ambientExpanded[agentId];
    card.className = 'agent-feed-card ' + (existing.status || 'working') + (folded ? ' folded' : '') + (ambient ? ' ambient' : '') + ((existing.type === 'orchestrator' || existing.type === 'supervisor') ? ' supervisor' : '');
    card.setAttribute('data-terminal', nowTerminal ? '1' : '0');
    if (update.streamText) {
      var textEl = card.querySelector('.worker-text');
      if (textEl) {
        // Only auto-scroll if the user is ALREADY pinned to (or near) the
        // bottom. If they've scrolled up to read prior reasoning, leave
        // their position alone — otherwise every delta yanks them back
        // down and reading is impossible. 40px hysteresis covers tiny
        // overshoot from the previous append.
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
      if (countEl) countEl.textContent = String(lines.length); // one entry per non-empty output line
      // Always-visible single-line preview of the most recent activity.
      // Lives under the worker name so the user has continuous liveness
      // feedback without having to expand the (potentially collapsed)
      // worker-tools-body. Field report: count badge alone wasn't enough
      // — a 1-line/10s tick rate is below the user's visual threshold,
      // and clicking another chat and back was the only way to "see
      // motion" (because chat-switch re-renders from agentFeedsData via
      // init_chat → _renderAgentFeedsList).
      var latestEl = card.querySelector('.worker-latest');
      if (latestEl && lines.length > 0) latestEl.textContent = lines[lines.length - 1];
    }
    // Token meter (Part B): running per-op total rides in on bg_op_progress
    // (observer forwards turn_committed usage) — set label + scale bar fill.
    if (update.totalTokens != null) {
      var tokCntEl = card.querySelector('.worker-token-count');
      if (tokCntEl) tokCntEl.textContent = formatTokens(existing.totalTokens) + ' tok';
      var tokFillEl = card.querySelector('.worker-token-bar-fill');
      if (tokFillEl) tokFillEl.style.width = tokenBarFillPct(existing.totalTokens) + '%';
    }
    var statusEl = card.querySelector('.agent-feed-status');
    if (statusEl) {
      statusEl.innerHTML = '<span class="agent-status-dot"></span> ' + esc(existing.status || 'working');
    }
    // Build_app and other URL-producing ops set resultUrl on completion.
    // Render as a clickable "Open" link below the worker activity. The
    // markup (incl. the ?token= auth append for /api/* URLs) is built by
    // resultLinkHtml in chat-agent-feeds-render.js — one chokepoint shared
    // with the render-time paths, so live write and re-render stay identical.
    if (update.resultUrl) {
      var linkEl = card.querySelector('.agent-feed-result-link');
      if (linkEl) {
        linkEl.innerHTML = resultLinkHtml(update.resultUrl);
        linkEl.style.display = 'block';
      }
    }
    // Re-render the control buttons. Without this, hitting Pause flipped the
    // status text to "paused" but the button stayed as "Pause" forever.
    var controlsEl = card.querySelector('.agent-feed-controls');
    if (controlsEl) {
      var safeId = esc(agentId);
      var isPaused = existing.status === 'paused';
      controlsEl.innerHTML =
        (isPaused
          ? '<button class="agent-ctrl-btn" data-agent-action="resume" data-agent-id="' + safeId + '">Resume</button>'
          : '<button class="agent-ctrl-btn" data-agent-action="pause" data-agent-id="' + safeId + '">Pause</button>') +
        '<button class="agent-ctrl-btn" data-agent-action="redirect" data-agent-id="' + safeId + '">Redirect</button>' +
        '<button class="agent-ctrl-btn cancel" data-agent-action="cancel" data-agent-id="' + safeId + '">Cancel</button>';
    }
  } else {
    _renderAgentFeedsList();
  }
  _updateAgentCount();
}

function removeAgentFeed(agentId) {
  delete agentFeedsData[agentId];
  delete animatedCardIds['agent-card-' + agentId]; // re-animate if this id comes back; don't leak
  var card = document.getElementById('agent-card-' + agentId);
  if (card) card.remove();
  _updateAgentCount();
}

// C6 run-lineage: the PURE tree builder `buildAgentFeedTree(agentFeedsData)`
// lives in chat-agent-feeds-render.js (the pure-producers sibling, loaded
// before this file) alongside renderAgentCard / renderAgentFeedGroup — it
// takes the feeds map and returns the nested render-node tree. See that file
// (and its unit test chat-agent-feeds-tree.test.ts) for the tree semantics,
// the synthetic fan-out grouping, and the cycle/leftover guarantees.

// Recursively render one tree node to markup. Card nodes keep their
// id="agent-card-<id>" so updateAgentFeed's targeted writes + the 1s resync
// still find them; children ride in a sibling `.agent-feed-children`.
function _renderAgentFeedNode(node) {
  if (node.kind === 'group') {
    var groupChildren = node.children.map(_renderAgentFeedNode).join('');
    return renderAgentFeedGroup(node.parentOpId, node.count, groupChildren);
  }
  var childrenHtml = (node.children && node.children.length)
    ? node.children.map(_renderAgentFeedNode).join('')
    : '';
  return renderAgentCard(agentFeedsData[node.id], childrenHtml);
}

function _renderAgentFeedsList() {
  var list = document.getElementById('agent-feeds-list');
  if (!list) return;
  // Split ambient dream/cron agents into their own dock (below); MAIN keeps only
  // build/chat/orchestrator cards so the main tree is byte-identical without them.
  var parts = partitionAmbient(agentFeedsData);
  if (Object.keys(parts.main).length === 0) {
    list.innerHTML = Object.keys(parts.ambient).length ? '' : '<div style="text-align:center;padding:20px;color:var(--muted);font-family:var(--mono);font-size:.72rem">No active agents</div>';
  } else {
    list.innerHTML = buildAgentFeedTree(parts.main).map(_renderAgentFeedNode).join('');
    // Animate only cards that haven't animated before — a rebuild triggered by a
    // progress tick must not replay the entrance on already-visible cards.
    var fresh = Array.from(list.querySelectorAll('.agent-feed-card')).filter(function(el) {
      if (animatedCardIds[el.id]) return false;
      animatedCardIds[el.id] = 1;
      return true;
    });
    if (fresh.length && typeof Spring !== 'undefined') Spring.staggerIn(fresh, { delay: 50, preset: 'stiff' });
  }
  var region = document.getElementById('agent-feeds-ambient'); if (region) { var ah = renderAmbientRegion(parts.ambient, ambientExpanded); region.innerHTML = ah; region.style.display = ah ? '' : 'none'; }
  _updateAgentCount();
}

function _updateAgentCount() {
  var count = Object.keys(agentFeedsData).length;
  var el = document.getElementById('agent-count');
  if (el) el.textContent = count;
}

// 1s safety-net sync: re-applies the visible DOM of every non-terminal
// worker card from agentFeedsData. updateAgentFeed already does this
// per-event via direct textContent writes, but field reports show the
// count and latest-line silently freezing until a chat-switch forces a
// full re-render via init_chat → _renderAgentFeedsList. Suspected
// cause: a compositing/paint hiccup during Spring staggerIn animations
// where transforms isolate the card's layer and subsequent textContent
// writes don't trigger a paint until the layer is invalidated by an
// unrelated render. Without a reliable repro it's faster to ship a
// belt-and-suspenders tick than chase the exact race. 1s cadence is
// cheap (textContent writes only, no innerHTML rebuilds) and matches
// the user's "I see motion every second or two" expectation.
// Delegated card click/keydown handlers (inline-card scroll, control buttons,
// header fold, redirect input) live in chat-agent-feeds-actions.js with the
// on*Agent handlers they dispatch to — moved when this file hit the 400-LOC
// source-hygiene ceiling.

setInterval(function() {
  var ids = Object.keys(agentFeedsData);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var d = agentFeedsData[id];
    if (!d) continue;
    var s = (d.status || '').toLowerCase();
    if (s === 'completed' || s === 'failed' || s === 'cancelled') continue;
    var card = document.getElementById('agent-card-' + id);
    if (!card) continue;
    var output = d.output || '';
    var lines = output.split('\n').filter(function(l) { return l.trim().length > 0; });
    var countEl = card.querySelector('.worker-tools-count');
    if (countEl && countEl.textContent !== String(lines.length)) countEl.textContent = String(lines.length);
    var latestEl = card.querySelector('.worker-latest');
    var latest = lines.length > 0 ? lines[lines.length - 1] : null;
    if (latestEl && latest != null && latestEl.textContent !== latest) latestEl.textContent = latest;
    var toolsBody = card.querySelector('.worker-tools-body');
    if (toolsBody && toolsBody.textContent !== output) {
      var atBottomT = (toolsBody.scrollHeight - toolsBody.scrollTop - toolsBody.clientHeight) < 40;
      toolsBody.textContent = output;
      if (atBottomT) toolsBody.scrollTop = toolsBody.scrollHeight;
    }
    if (d.streamText) {
      var textEl = card.querySelector('.worker-text');
      if (textEl && textEl.textContent !== d.streamText) {
        var atBottom = (textEl.scrollHeight - textEl.scrollTop - textEl.clientHeight) < 40;
        textEl.textContent = d.streamText;
        if (atBottom) textEl.scrollTop = textEl.scrollHeight;
      }
    }
  }
}, 1000);
