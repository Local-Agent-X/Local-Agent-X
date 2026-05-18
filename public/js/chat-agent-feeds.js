// ── Agent Feeds (Mission Control) ──
//
// Right-rail Agents panel — shows live worker / agent ops the supervisor
// has spawned, with per-card pause / resume / redirect / cancel /
// stay-inline controls. Background-op events (`bg_op_queued/started/
// progress/completed`) flow into here from chat.js's WS message handler.
//
// Extracted from chat.js as part of the 400-LOC god-file split.
//
// External deps from chat.js / shared.js:
//   - window.esc                    (shared.js)
//   - window.apiPost                (shared.js)
//   - window.Spring                 (spring.js)
//   - window.sendChatWsControl(p)   (chat.js helper — wraps the chat WS
//                                    send so this module never touches
//                                    chat WS state directly)
//   - sendMessage                   (chat.js — top-level function, available
//                                    on window after chat.js loads)

const AGENT_ROLE_ICONS = {
  researcher: '🔍', writer: '✍️', coder: '💻',
  reviewer: '🔎', 'social-media': '📱', analyst: '📊',
  monitor: '👁️', designer: '🎨', ops: '⚙️',
  communicator: '📨'
};
let agentFeedsOpen = false;
let agentFeedsData = {};
// Auto-open the AGENTS panel whenever an agent spawns. User-toggleable
// via the AUTO pill in the panel header. Persisted two ways so a wiped
// webview localStorage can't lose the user's choice:
//   1. localStorage (fast, in-memory at boot)
//   2. server settings.json via /api/settings (durable, source of truth)
// Boot reads localStorage first for instant correct paint, then hits the
// server async — if the server has a different value, it wins and the
// button re-renders. Default ON to match prior behavior.
let agentFeedsAutoOpen = (function() {
  try { var raw = localStorage.getItem('lax_agent_feeds_autoopen'); return raw === null ? true : raw === '1'; }
  catch { return true; }
})();

function toggleAgentFeedsAutoOpen() {
  agentFeedsAutoOpen = !agentFeedsAutoOpen;
  try { localStorage.setItem('lax_agent_feeds_autoopen', agentFeedsAutoOpen ? '1' : '0'); } catch {}
  // Best-effort server-side persist. Don't block the UI on it — localStorage
  // already covered the fast path. apiPost is defined in shared.js and
  // tolerates the server being down (the toggle still works locally).
  try {
    if (typeof apiPost === 'function') {
      apiPost('/api/settings', { agentFeedsAutoOpen: agentFeedsAutoOpen }).catch(function() {});
    }
  } catch {}
  _updateAutoOpenButton();
}

function _updateAutoOpenButton() {
  var btn = document.getElementById('agent-feeds-autoopen-toggle');
  if (!btn) return;
  if (agentFeedsAutoOpen) { btn.classList.add('on'); btn.classList.remove('off'); btn.title = 'Auto-open ON — panel opens whenever an agent spawns. Click to disable.'; }
  else { btn.classList.add('off'); btn.classList.remove('on'); btn.title = 'Auto-open OFF — panel stays closed when agents spawn. Click to enable.'; }
}

// Pull the server-side value once on boot. If it disagrees with what we
// loaded from localStorage (because localStorage got wiped by a webview
// session reset, but settings.json on disk is still intact), the server
// value wins — that's the durable source of truth.
function _hydrateAutoOpenFromServer() {
  try {
    if (typeof fetch !== 'function') return;
    var headers = {};
    if (typeof AUTH_TOKEN !== 'undefined' && AUTH_TOKEN) headers.Authorization = 'Bearer ' + AUTH_TOKEN;
    fetch((typeof API !== 'undefined' ? API : '') + '/api/settings', { headers: headers })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || typeof data.agentFeedsAutoOpen !== 'boolean') return;
        if (data.agentFeedsAutoOpen === agentFeedsAutoOpen) return;
        agentFeedsAutoOpen = data.agentFeedsAutoOpen;
        try { localStorage.setItem('lax_agent_feeds_autoopen', agentFeedsAutoOpen ? '1' : '0'); } catch {}
        _updateAutoOpenButton();
      })
      .catch(function() {});
  } catch {}
}

// Sync the button visual to the persisted state once the DOM is ready.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { _updateAutoOpenButton(); _hydrateAutoOpenFromServer(); });
  } else {
    _updateAutoOpenButton();
    _hydrateAutoOpenFromServer();
  }
}

function toggleAgentFeeds() {
  var panel = document.getElementById('agent-feeds');
  if (!panel) return;
  agentFeedsOpen = !agentFeedsOpen;
  panel.style.transition = 'none';
  if (agentFeedsOpen) {
    panel.classList.remove('collapsed');
    panel.classList.add('active');
    panel.querySelector('.agent-feeds-toggle').innerHTML = '&#9654;';
    // Toggle visibility is driven from a body class, not inline style on
    // the button. Inline style was getting clobbered by navigate('chat')
    // in app.js (fires on hashchange, file drop, new chat, select chat),
    // which unconditionally sets agents-toggle display=''. The body-class
    // + CSS !important is immune to that.
    document.body.classList.add('agents-panel-open');
    panel.style.overflow = 'hidden';
    Spring.animate(panel, 'width', 320, { from: 0, preset: 'stiff', unit: 'px', onUpdate: function(v) { panel.style.minWidth = v + 'px'; }, onDone: function() { panel.style.overflow = 'visible'; panel.style.transition = ''; } });
  } else {
    panel.querySelector('.agent-feeds-toggle').innerHTML = '&#9664;';
    Spring.animate(panel, 'width', 0, { from: 320, preset: 'stiff', unit: 'px', onUpdate: function(v) { panel.style.minWidth = v + 'px'; }, onDone: function() { panel.classList.remove('active'); panel.classList.add('collapsed'); document.body.classList.remove('agents-panel-open'); panel.style.transition = ''; } });
  }
}

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
  }
  var card = document.getElementById('agent-card-' + agentId);
  if (card) {
    card.className = 'agent-feed-card ' + (existing.status || 'working');
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
      if (countEl) {
        // Each non-empty newline-separated chunk = one tool/lifecycle entry.
        countEl.textContent = String(lines.length);
      }
      // Always-visible single-line preview of the most recent activity.
      // Lives under the worker name so the user has continuous liveness
      // feedback without having to expand the (potentially collapsed)
      // worker-tools-body. Field report: count badge alone wasn't enough
      // — a 1-line/10s tick rate is below the user's visual threshold,
      // and clicking another chat and back was the only way to "see
      // motion" (because chat-switch re-renders from agentFeedsData via
      // init_chat → _renderAgentFeedsList).
      var latestEl = card.querySelector('.worker-latest');
      if (latestEl && lines.length > 0) {
        latestEl.textContent = lines[lines.length - 1];
      }
    }
    var statusEl = card.querySelector('.agent-feed-status');
    if (statusEl) {
      statusEl.innerHTML = '<span class="agent-status-dot"></span> ' + esc(existing.status || 'working');
    }
    // Build_app and other URL-producing ops set resultUrl on completion.
    // Render as a clickable "Open" link below the worker activity. esc()
    // on the href guards against any agent-controlled string reaching href.
    if (update.resultUrl) {
      var linkEl = card.querySelector('.agent-feed-result-link');
      if (linkEl) {
        var safeUrl = esc(update.resultUrl);
        linkEl.innerHTML = '<a href="' + safeUrl + '" target="_blank" rel="noopener" style="color:var(--accent,#3a7);text-decoration:none">↗ Open: ' + safeUrl + '</a>';
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
          ? '<button class="agent-ctrl-btn" onclick="onAgentResume(\'' + safeId + '\')">Resume</button>'
          : '<button class="agent-ctrl-btn" onclick="onAgentPause(\'' + safeId + '\')">Pause</button>') +
        '<button class="agent-ctrl-btn" onclick="onAgentRedirect(\'' + safeId + '\')">Redirect</button>' +
        '<button class="agent-ctrl-btn cancel" onclick="onAgentCancel(\'' + safeId + '\')">Cancel</button>';
    }
  } else {
    _renderAgentFeedsList();
  }
  _updateAgentCount();
}

function removeAgentFeed(agentId) {
  delete agentFeedsData[agentId];
  var card = document.getElementById('agent-card-' + agentId);
  if (card) card.remove();
  _updateAgentCount();
}

function renderAgentCard(agent) {
  var icon = AGENT_ROLE_ICONS[agent.role] || '🤖';
  var status = agent.status || 'working';
  var streamText = agent.streamText || '';
  var output = agent.output || '';
  var outputLines = output.split('\n').filter(function(l) { return l.trim().length > 0; });
  var initialToolCount = outputLines.length;
  var latestLine = outputLines.length > 0 ? outputLines[outputLines.length - 1] : '';
  var isPaused = status === 'paused';
  var isActive = !(status === 'completed' || status === 'failed' || status === 'cancelled');
  var safeId = esc(agent.id);
  // Body shape mirrors the main chat layout, smaller, in the right rail:
  //   .worker-text         — worker's reasoning (worker_stream deltas), like
  //                          the assistant text bubble in main chat.
  //   .worker-tools-group  — collapsible activity-group of tool calls /
  //                          lifecycle markers (bg_op_progress + queued/
  //                          started/completed lines), default collapsed,
  //                          click to expand. Mirrors the "⚙ Agent activity
  //                          (N)" pattern on the main chat side.
  // worker-latest = ALWAYS-visible most-recent bg_op_progress line.
  // Without this, the only liveness cue on a collapsed card is the small
  // tools-count badge — easy to miss between visual saccades. Field
  // report: "I see it work then it freezes then I leave and come back
  // and it jumps then I can see it live again". The badge was actually
  // ticking the whole time; the user couldn't tell because the body was
  // collapsed and 1 line/10s of count change is below their attention
  // threshold. A real text preview right under the name updates on every
  // event and is impossible to miss.
  //
  // Worker activity defaults to OPEN while the worker is active so
  // users see the full stream without needing to expand. Auto-collapses
  // on terminal state via updateAgentFeed so finished cards don't
  // accumulate visual weight.
  var bodyDisplay = isActive ? 'block' : 'none';
  var bodyOpenClass = isActive ? ' open' : '';
  var chevron = isActive ? '▼' : '▶';
  return '<div id="agent-card-' + safeId + '" class="agent-feed-card ' + status + '">' +
    '<div class="agent-feed-header">' +
      '<span class="agent-feed-icon">' + icon + '</span>' +
      '<span class="agent-feed-name">' + esc(agent.name || agent.id) + '</span>' +
      '<span class="agent-feed-status"><span class="agent-status-dot"></span> ' + esc(status) + '</span>' +
      '<button class="agent-feed-dismiss" title="Dismiss card (does not cancel)" onclick="onAgentDismiss(\'' + safeId + '\')">×</button>' +
    '</div>' +
    '<div class="worker-latest" style="padding:.25rem .55rem;font-family:var(--mono,monospace);font-size:.68rem;color:var(--muted,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid var(--border,#333);min-height:1.2em">' + esc(latestLine) + '</div>' +
    '<div class="worker-text" style="white-space:pre-wrap;font-size:.78rem;line-height:1.35;color:var(--text,#ddd);padding:.4rem .55rem;max-height:240px;overflow-y:auto">' + esc(streamText) + '</div>' +
    '<div class="worker-tools-group' + bodyOpenClass + '" style="border-top:1px solid var(--border,#333);background:rgba(0,0,0,0.18)">' +
      '<div class="worker-tools-header" style="cursor:pointer;padding:.35rem .55rem;display:flex;align-items:center;gap:.4rem;font-size:.7rem;color:var(--muted,#888);user-select:none" ' +
        'onclick="var b=this.parentElement.querySelector(\'.worker-tools-body\');var open=this.parentElement.classList.toggle(\'open\');if(b)b.style.display=open?\'block\':\'none\';this.querySelector(\'.worker-tools-chevron\').textContent=open?\'\\u25BC\':\'\\u25B6\'">' +
        '<span style="opacity:.8">⚙</span>' +
        '<span style="flex:1">Worker activity</span>' +
        '<span class="worker-tools-count" style="font-variant-numeric:tabular-nums">' + initialToolCount + '</span>' +
        '<span class="worker-tools-chevron">' + chevron + '</span>' +
      '</div>' +
      '<div class="worker-tools-body" style="display:' + bodyDisplay + ';font-family:var(--mono,monospace);font-size:.68rem;color:var(--muted,#888);padding:.3rem .55rem .45rem;max-height:200px;overflow-y:auto;white-space:pre-wrap">' + esc(output) + '</div>' +
    '</div>' +
    '<div class="agent-feed-result-link" style="display:none;padding:.4rem .55rem;font-size:.75rem;border-top:1px solid var(--border,#333)"></div>' +
    '<div class="agent-feed-controls">' +
      (isPaused
        ? '<button class="agent-ctrl-btn" onclick="onAgentResume(\'' + safeId + '\')">Resume</button>'
        : '<button class="agent-ctrl-btn" onclick="onAgentPause(\'' + safeId + '\')">Pause</button>') +
      '<button class="agent-ctrl-btn" onclick="onAgentRedirect(\'' + safeId + '\')">Redirect</button>' +
      '<button class="agent-ctrl-btn" title="This should have been a chat reply, not a worker. Kills this op and re-asks inline." onclick="onAgentStayInline(\'' + safeId + '\')">Stay inline</button>' +
      '<button class="agent-ctrl-btn cancel" onclick="onAgentCancel(\'' + safeId + '\')">Cancel</button>' +
    '</div>' +
    '<input class="agent-redirect-input" id="agent-redirect-' + safeId + '" placeholder="New instructions..." ' +
      'onkeydown="if(event.key===\'Enter\'){sendAgentRedirect(\'' + safeId + '\',this.value);this.value=\'\';this.classList.remove(\'visible\')}" />' +
  '</div>';
}

function renderAgentCard_inline(agent) {
  var icon = AGENT_ROLE_ICONS[agent.role] || '🤖';
  var status = agent.status || 'working';
  var progress = agent.progress || '';
  return '<div class="agent-inline-card" onclick="toggleAgentFeeds();var c=document.getElementById(\'agent-card-' + esc(agent.id) + '\');if(c)c.scrollIntoView({behavior:\'smooth\'})">' +
    '<span class="agent-inline-icon">' + icon + '</span>' +
    '<span class="agent-inline-name">' + esc(agent.name || agent.id) + '</span>' +
    '<span class="agent-inline-status">' + esc(status) + '</span>' +
    (progress ? '<span class="agent-inline-progress">' + esc(progress) + '</span>' : '') +
  '</div>';
}

function onAgentRedirect(agentId) {
  var input = document.getElementById('agent-redirect-' + agentId);
  if (!input) return;
  var isVisible = input.classList.contains('visible');
  input.classList.toggle('visible');
  if (!isVisible) input.focus();
}

function sendAgentRedirect(agentId, instruction) {
  if (!instruction || !instruction.trim()) return;
  var payload = { type: 'agent-redirect', agentId: agentId, instruction: instruction.trim() };
  if (typeof window.sendChatWsControl === 'function' && window.sendChatWsControl(payload)) return;
  // Fallback: direct HTTP redirect when the chat WS isn't open
  fetch(API + '/api/agents/' + agentId + '/redirect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AUTH_TOKEN },
    body: JSON.stringify({ instruction: instruction.trim() })
  }).catch(function() {});
}

function onAgentPause(agentId) {
  // Backend route by id prefix: op_* → worker pool; agent-* → legacy Handler.
  // UI flips to "paused" either way so the button toggles to Resume.
  if (typeof window.sendChatWsControl === 'function') {
    window.sendChatWsControl({ type: 'agent-control', agentId: agentId, action: 'pause' });
  }
  // Status MUST be exactly 'paused' so renderAgentCard's isPaused check
  // swaps the button to Resume.
  updateAgentFeed(agentId, { status: 'paused' });
}

function onAgentResume(agentId) {
  if (typeof window.sendChatWsControl === 'function') {
    window.sendChatWsControl({ type: 'agent-control', agentId: agentId, action: 'resume' });
  }
  updateAgentFeed(agentId, { status: 'working' });
}

function onAgentCancel(agentId) {
  if (typeof window.sendChatWsControl === 'function') {
    window.sendChatWsControl({ type: 'agent-control', agentId: agentId, action: 'cancel' });
  }
  // Mark as cancelled and remove. Backend (chat-ws.ts) routes by id prefix:
  // op_* → killOp (real worker subprocess kill); agent-* → legacy Handler.
  updateAgentFeed(agentId, { status: 'cancelled' });
  setTimeout(function() { removeAgentFeed(agentId); }, 1500);
}

// User clicked "Stay inline" — POST to /api/auto-delegate/override which
// kills the op + tags the decision as a user-correction (training signal)
// + returns the original message so we can re-submit with /discuss prefix.
async function onAgentStayInline(agentId) {
  try {
    const r = await apiPost('/api/auto-delegate/override', { opId: agentId });
    const data = await r.json();
    updateAgentFeed(agentId, { status: 'overridden — re-asking inline' });
    setTimeout(function() { removeAgentFeed(agentId); }, 1500);
    if (data && data.message) {
      const ta = document.getElementById('msg-input');
      if (ta) {
        ta.value = '/discuss ' + data.message;
        try { sendMessage(); } catch (e) { console.warn('[stay-inline] resubmit failed:', e); }
      }
    } else {
      console.info('[stay-inline] no message to resubmit (op was not auto-delegated)');
    }
  } catch (e) {
    console.warn('[stay-inline] override failed:', e);
  }
}

function onAgentDismiss(agentId) {
  // Pure UI hide — does NOT cancel/kill the underlying op. Use Cancel
  // (X-shaped circle) to actually kill the worker.
  removeAgentFeed(agentId);
}

function _renderAgentFeedsList() {
  var list = document.getElementById('agent-feeds-list');
  if (!list) return;
  var ids = Object.keys(agentFeedsData);
  if (ids.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-family:var(--mono);font-size:.72rem">No active agents</div>';
  } else {
    list.innerHTML = ids.map(function(id) { return renderAgentCard(agentFeedsData[id]); }).join('');
    if (typeof Spring !== 'undefined') {
      Spring.staggerIn(Array.from(list.querySelectorAll('.agent-feed-card')), { delay: 50, preset: 'stiff' });
    }
  }
  _updateAgentCount();
}

function _updateAgentCount() {
  var count = Object.keys(agentFeedsData).length;
  var el = document.getElementById('agent-count');
  if (el) el.textContent = count;
  var toggleCount = document.getElementById('agents-toggle-count');
  if (toggleCount) toggleCount.textContent = count;
  var toggleBtn = document.getElementById('agents-toggle');
  if (toggleBtn) toggleBtn.style.borderColor = count > 0 ? 'var(--accent)' : 'var(--border)';
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
    if (countEl && countEl.textContent !== String(lines.length)) {
      countEl.textContent = String(lines.length);
    }
    var latestEl = card.querySelector('.worker-latest');
    if (latestEl && lines.length > 0) {
      var latest = lines[lines.length - 1];
      if (latestEl.textContent !== latest) latestEl.textContent = latest;
    }
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
