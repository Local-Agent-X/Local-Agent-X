// ── Agent Feeds — card HTML ──
// Pure HTML producers. No DOM lookups, no state mutations — given an
// agent record, return the markup. Wired into chat-agent-feeds.js (panel
// list) and chat-send-http.js (inline agent-spawn/agent-status events).

const AGENT_ROLE_ICONS = {
  researcher: '🔍', writer: '✍️', coder: '💻',
  reviewer: '🔎', 'social-media': '📱', analyst: '📊',
  monitor: '👁️', designer: '🎨', ops: '⚙️',
  communicator: '📨'
};

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
