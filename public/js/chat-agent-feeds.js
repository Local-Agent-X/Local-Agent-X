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

function toggleAgentFeeds() {
  var panel = document.getElementById('agent-feeds');
  var toggleBtn = document.getElementById('agents-toggle');
  if (!panel) return;
  agentFeedsOpen = !agentFeedsOpen;
  panel.style.transition = 'none';
  if (agentFeedsOpen) {
    panel.classList.remove('collapsed');
    panel.classList.add('active');
    panel.querySelector('.agent-feeds-toggle').innerHTML = '&#9654;';
    if (toggleBtn) toggleBtn.style.display = 'none';
    panel.style.overflow = 'hidden';
    Spring.animate(panel, 'width', 320, { from: 0, preset: 'stiff', unit: 'px', onUpdate: function(v) { panel.style.minWidth = v + 'px'; }, onDone: function() { panel.style.overflow = 'visible'; panel.style.transition = ''; } });
  } else {
    panel.querySelector('.agent-feeds-toggle').innerHTML = '&#9664;';
    Spring.animate(panel, 'width', 0, { from: 320, preset: 'stiff', unit: 'px', onUpdate: function(v) { panel.style.minWidth = v + 'px'; }, onDone: function() { panel.classList.remove('active'); panel.classList.add('collapsed'); if (toggleBtn) toggleBtn.style.display = ''; panel.style.transition = ''; } });
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
  agentFeedsData[agent.id] = agent;
  if (!agentFeedsOpen) toggleAgentFeeds();
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
      if (countEl) {
        // Each non-empty newline-separated chunk = one tool/lifecycle entry.
        var lines = (existing.output || '').split('\n').filter(function(l) { return l.trim().length > 0; });
        countEl.textContent = String(lines.length);
      }
    }
    var statusEl = card.querySelector('.agent-feed-status');
    if (statusEl) {
      statusEl.innerHTML = '<span class="agent-status-dot"></span> ' + esc(existing.status || 'working');
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
  var initialToolCount = output.split('\n').filter(function(l) { return l.trim().length > 0; }).length;
  var isPaused = status === 'paused';
  var safeId = esc(agent.id);
  // Body shape mirrors the main chat layout, smaller, in the right rail:
  //   .worker-text         — worker's reasoning (worker_stream deltas), like
  //                          the assistant text bubble in main chat.
  //   .worker-tools-group  — collapsible activity-group of tool calls /
  //                          lifecycle markers (bg_op_progress + queued/
  //                          started/completed lines), default collapsed,
  //                          click to expand. Mirrors the "⚙ Agent activity
  //                          (N)" pattern on the main chat side.
  return '<div id="agent-card-' + safeId + '" class="agent-feed-card ' + status + '">' +
    '<div class="agent-feed-header">' +
      '<span class="agent-feed-icon">' + icon + '</span>' +
      '<span class="agent-feed-name">' + esc(agent.name || agent.id) + '</span>' +
      '<span class="agent-feed-status"><span class="agent-status-dot"></span> ' + esc(status) + '</span>' +
      '<button class="agent-feed-dismiss" title="Dismiss card (does not cancel)" onclick="onAgentDismiss(\'' + safeId + '\')">×</button>' +
    '</div>' +
    '<div class="worker-text" style="white-space:pre-wrap;font-size:.78rem;line-height:1.35;color:var(--text,#ddd);padding:.4rem .55rem;max-height:240px;overflow-y:auto">' + esc(streamText) + '</div>' +
    '<div class="worker-tools-group" style="border-top:1px solid var(--border,#333);background:rgba(0,0,0,0.18)">' +
      '<div class="worker-tools-header" style="cursor:pointer;padding:.35rem .55rem;display:flex;align-items:center;gap:.4rem;font-size:.7rem;color:var(--muted,#888);user-select:none" ' +
        'onclick="var b=this.parentElement.querySelector(\'.worker-tools-body\');var open=this.parentElement.classList.toggle(\'open\');if(b)b.style.display=open?\'block\':\'none\';this.querySelector(\'.worker-tools-chevron\').textContent=open?\'\\u25BC\':\'\\u25B6\'">' +
        '<span style="opacity:.8">⚙</span>' +
        '<span style="flex:1">Worker activity</span>' +
        '<span class="worker-tools-count" style="font-variant-numeric:tabular-nums">' + initialToolCount + '</span>' +
        '<span class="worker-tools-chevron">▶</span>' +
      '</div>' +
      '<div class="worker-tools-body" style="display:none;font-family:var(--mono,monospace);font-size:.68rem;color:var(--muted,#888);padding:.3rem .55rem .45rem;max-height:200px;overflow-y:auto;white-space:pre-wrap">' + esc(output) + '</div>' +
    '</div>' +
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
