// ── Agent Feeds — background-tasks layout ──
// Pure HTML producers for the AGENTS panel's one list: running jobs (a root
// op with the workers it spawned, as phase tables), running single tasks,
// ambient dream/mission ops, and a Finished drawer. No DOM lookups, no state
// mutations. Uses the render file's globals (iconForType, isTerminalStatus,
// formatTokens, renderAgentCard, buildAgentFeedTree) and the ambient file's
// partitionAmbient via the classic <script> lexical environment.
//
// Every record keeps its `agent-card-<id>` detail (renderAgentCard, embedded)
// under its row, so updateAgentFeed's targeted writes keep landing. Row cells
// carry their own classes (.job-row-status / -tokens / -time) and are synced
// by chat-agent-feeds-sync.js.

// A live op that has emitted nothing for this long reads as stalled: the row
// says so and offers Cancel. The server's lease is longer; this is the
// user-facing cue, not the recovery.
var JOB_STALL_MS = 120000;

// Pure: "2m 30s" / "1h 02m" from millisecond timestamps. '' with no start.
function jobElapsedLabel(startedAt, endedAt, now) {
  var start = Number(startedAt) || 0;
  if (start <= 0) return '';
  var end = Number(endedAt) || Number(now) || 0;
  var s = Math.floor(Math.max(0, end - start) / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  var rs = s % 60;
  if (m < 60) return m + 'm ' + (rs < 10 ? '0' : '') + rs + 's';
  var h = Math.floor(m / 60);
  var rm = m % 60;
  return h + 'h ' + (rm < 10 ? '0' : '') + rm + 'm';
}

function jobIsQueued(status) {
  return /^queued/i.test(String(status == null ? '' : status).trim());
}

// Pure: the outcome word and its CSS class for a status token.
function jobOutcome(status) {
  var s = String(status == null ? '' : status).trim().toLowerCase();
  if (s === 'completed' || s === 'done' || s === 'succeeded') return { label: 'Completed', cls: 'ok' };
  if (s === 'failed' || s === 'error') return { label: 'Failed', cls: 'failed' };
  if (s === 'cancelled') return { label: 'Cancelled', cls: 'cancelled' };
  if (s === 'partial') return { label: 'Stopped', cls: 'partial' };
  if (jobIsQueued(s)) return { label: 'Queued', cls: 'queued' };
  if (s === 'paused' || s === 'blocked' || s === 'stalled') return { label: s, cls: 'paused' };
  return { label: 'Running', cls: 'running' };
}

// Pure: ms since the op's last signal when that exceeds JOB_STALL_MS; else 0.
function jobStallMs(rec, now) {
  if (!rec || isTerminalStatus(rec.status) || jobIsQueued(rec.status)) return 0;
  var last = Number(rec.lastActivityMs) || 0;
  if (last <= 0) return 0;
  var gap = (Number(now) || 0) - last;
  return gap >= JOB_STALL_MS ? gap : 0;
}

var JOB_KIND_LABELS = {
  app_build: 'App build', build_app: 'App build', app_builder: 'App build',
  self_edit: 'Self edit', refactor: 'Refactor', autopilot: 'Autopilot',
  research: 'Research', agent: 'Agent', agent_spawn: 'Agent',
  orchestrator: 'Build', supervisor: 'Build',
  memory_consolidation: 'Dream', scheduled_mission: 'Mission'
};
function jobKindLabel(type) {
  return JOB_KIND_LABELS[type] || (type ? String(type).replace(/_/g, ' ') : 'Task');
}

// Pure: every card id under a tree node (the node's own card included).
function jobCollectIds(node) {
  var out = [];
  (function walk(n) {
    if (!n) return;
    if (n.kind === 'card') out.push(n.id);
    var kids = n.children || [];
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  })(node);
  return out;
}

function jobIsFinished(node, dataMap) {
  var ids = jobCollectIds(node);
  if (ids.length === 0) return false;
  for (var i = 0; i < ids.length; i++) {
    var rec = (dataMap || {})[ids[i]];
    if (!rec || !isTerminalStatus(rec.status)) return false;
  }
  return true;
}

// Pure: roll-up for a job header.
function jobTotals(ids, dataMap) {
  var tokens = 0, done = 0;
  for (var i = 0; i < ids.length; i++) {
    var rec = (dataMap || {})[ids[i]] || {};
    tokens += Number(rec.totalTokens) || 0;
    if (isTerminalStatus(rec.status)) done++;
  }
  return { agents: ids.length, tokens: tokens, done: done };
}

// Pure: the worker rows of a job, grouped into phases. A record may carry a
// `phase` name (the orchestrator's); rows without one share a single unnamed
// phase. Order is first-seen, which is arrival order.
function jobPhases(node, dataMap) {
  var ids = node.kind === 'group' ? jobCollectIds(node) : jobCollectIds(node).slice(1);
  var phases = [], byTitle = {};
  for (var i = 0; i < ids.length; i++) {
    var rec = (dataMap || {})[ids[i]] || {};
    var title = typeof rec.phase === 'string' ? rec.phase : '';
    if (!byTitle[title]) { byTitle[title] = { title: title, ids: [] }; phases.push(byTitle[title]); }
    byTitle[title].ids.push(ids[i]);
  }
  return phases;
}

function jobRowMark(rec) {
  if (isTerminalStatus(rec.status)) {
    var o = jobOutcome(rec.status);
    return '<span class="job-row-mark ' + o.cls + '">' + (o.cls === 'ok' ? '&#10003;' : '&#10007;') + '</span>';
  }
  if (jobIsQueued(rec.status)) return '<span class="job-row-mark queued">&#9675;</span>';
  return '<span class="job-row-mark running"><span class="agent-status-dot"></span></span>';
}

function jobStallBadge(rec, now) {
  var gap = jobStallMs(rec, now);
  if (!gap) return '';
  return '<span class="job-row-stall">stalled ' + jobElapsedLabel(Number(now) - gap, 0, now) + '</span>';
}

// Pure: the row's Time cell — the elapsed clock, or "stalled Xm" once the op
// has gone quiet (the stall is the more useful number then).
function jobRowTimeLabel(rec, now) {
  var gap = jobStallMs(rec, now);
  if (!gap) return jobElapsedLabel(rec.startedAt, rec.endedAt, now);
  var m = Math.floor(gap / 60000);
  return 'stalled ' + (m >= 60 ? Math.floor(m / 60) + 'h' : m + 'm');
}

// Pure: how many tool calls the trace records. Progress lines read
// "✓ turn N · read, edit" (session-bridge-observer); "thinking" is a turn
// with no tool.
function jobToolUses(rec) {
  var lines = String(rec.output || '').split('\n'), n = 0;
  for (var i = 0; i < lines.length; i++) {
    var m = /^✓ turn \d+ · (.+)$/.exec(lines[i].trim());
    if (!m || m[1] === 'thinking') continue;
    n += m[1].split(',').length;
  }
  return n;
}

// Pure: what the op is doing right now, from its latest trace line: the tool
// names of the last turn, or the line itself for lifecycle markers.
function jobActivityLabel(rec) {
  var lines = String(rec.output || '').split('\n').filter(function(l) { return l.trim().length > 0; });
  if (!lines.length) return '';
  var last = lines[lines.length - 1].trim();
  var m = /^✓ turn \d+ · (.+)$/.exec(last);
  var text = m ? (m[1] === 'thinking' ? 'Thinking' : 'Running ' + m[1]) : last;
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
}

// Pure: the transcript under a row or task card: the task's prompt, then the
// embedded card (latest line, stream text, tool trace, controls). Hidden
// until expanded; kept in the DOM so targeted writes never miss their
// selectors.
function jobDetailHtml(rec, expanded) {
  var prompt = String(rec.currentTask || '').trim();
  return '<div class="job-row-detail" style="display:' + (expanded ? 'block' : 'none') + '">' +
    (prompt ? '<div class="job-prompt"><div class="job-prompt-text">' + esc(prompt) + '</div>' +
      (prompt.length > 280 ? '<button class="job-prompt-more" data-prompt-toggle>Show more</button>' : '') + '</div>' : '') +
    renderAgentCard(rec) + '</div>';
}

// Pure: one worker row. The row id mirrors the card id so the sync tick can
// pair them: agent-row-<id> ↔ agent-card-<id>.
function renderJobRow(rec, now, expanded) {
  var safeId = esc(rec.id);
  var o = jobOutcome(rec.status);
  var stalled = jobStallMs(rec, now) > 0;
  return '<div class="job-row ' + o.cls + (stalled ? ' stalled' : '') + (expanded ? ' open' : '') + '" id="agent-row-' + safeId + '" data-agent-row="' + safeId + '">' +
      jobRowMark(rec) +
      '<span class="job-row-name" title="' + esc(rec.currentTask || rec.name || rec.id) + '">' + esc(rec.name || rec.id) + '</span>' +
      '<span class="job-row-model">' + esc(rec.model || '') + '</span>' +
      '<span class="job-row-tokens">' + (Number(rec.totalTokens) > 0 ? formatTokens(rec.totalTokens) : '') + '</span>' +
      '<span class="job-row-time">' + jobRowTimeLabel(rec, now) + '</span>' +
    '</div>' +
    jobDetailHtml(rec, expanded);
}

function renderPhaseDots(ids, dataMap) {
  var html = '';
  for (var i = 0; i < ids.length; i++) {
    var rec = (dataMap || {})[ids[i]] || {};
    var cls = isTerminalStatus(rec.status) ? 'done' : (jobIsQueued(rec.status) ? 'queued' : 'running');
    html += '<i class="job-dot ' + cls + '"></i>';
  }
  return html;
}

// Pure: one phase: head (title, done/total, dots, chevron) + its table.
// Open while any row is live, or when the user opened it (openMap).
function renderJobPhase(jobId, phase, dataMap, now, expandedMap, openMap) {
  var totals = jobTotals(phase.ids, dataMap);
  var key = jobId + '/' + phase.title;
  var open = openMap && key in openMap ? !!openMap[key] : totals.done < totals.agents;
  var rows = '';
  for (var i = 0; i < phase.ids.length; i++) {
    var rec = dataMap[phase.ids[i]];
    if (rec) rows += renderJobRow(rec, now, !!(expandedMap && expandedMap[rec.id]));
  }
  return '<div class="job-phase' + (open ? ' open' : '') + '" data-phase-key="' + esc(key) + '">' +
      '<div class="job-phase-head" data-phase-toggle="' + esc(key) + '">' +
        '<span class="job-phase-title">' + esc(phase.title || 'Workers') + '</span>' +
        '<span class="job-phase-count">' + totals.done + '/' + totals.agents + '</span>' +
        '<span class="job-phase-chevron">' + (open ? '&#9662;' : '&#9656;') + '</span>' +
        '<span class="job-phase-dots">' + renderPhaseDots(phase.ids, dataMap) + '</span>' +
      '</div>' +
      '<div class="job-table" style="display:' + (open ? 'block' : 'none') + '">' +
        '<div class="job-table-head"><span>Agent</span><span>Model</span><span>Tokens</span><span>Time</span></div>' +
        rows +
      '</div>' +
    '</div>';
}

function jobTaskLine(rec) {
  var t = String(rec.currentTask || '').split('\n').map(function(s) { return s.trim(); }).filter(Boolean)[0] || '';
  return t.length > 160 ? t.slice(0, 157) + '…' : t;
}

// Pure: a job block — a root op (or a fan-out) with the workers under it.
function renderJob(node, dataMap, now, expandedMap, openMap) {
  var root = node.kind === 'card' ? dataMap[node.id] : null;
  var ids = jobCollectIds(node);
  var totals = jobTotals(ids, dataMap);
  var finished = jobIsFinished(node, dataMap);
  var jobId = root ? root.id : ('fanout-' + node.parentOpId);
  var icon = root ? iconForType(root.type || root.role) : '&#9673;';
  var name = root ? (root.name || root.id) : 'Fan-out';
  var startedAt = root ? root.startedAt : 0;
  var endedAt = root ? root.endedAt : 0;
  if (!root) {
    for (var i = 0; i < ids.length; i++) {
      var r = dataMap[ids[i]] || {};
      if (r.startedAt && (!startedAt || r.startedAt < startedAt)) startedAt = r.startedAt;
      if (r.endedAt && r.endedAt > endedAt) endedAt = r.endedAt;
    }
  }
  var rootExpanded = !!(root && expandedMap && expandedMap[root.id]);
  var headAttr = root ? ' data-agent-row="' + esc(root.id) + '"' : '';
  var html = '<div class="job' + (finished ? ' finished' : '') + '" data-job-id="' + esc(jobId) + '">' +
    '<div class="job-head"' + headAttr + '>' +
      '<div class="job-head-row">' +
        '<span class="job-head-icon">' + icon + '</span>' +
        '<span class="job-head-name">' + esc(name) + '</span>' +
        '<span class="job-head-time">' + jobElapsedLabel(startedAt, finished ? endedAt : 0, now) + '</span>' +
      '</div>' +
      '<div class="job-head-meta">' +
        '<span>' + totals.agents + ' agent' + (totals.agents === 1 ? '' : 's') + '</span>' +
        (totals.tokens > 0 ? '<span>' + formatTokens(totals.tokens) + ' tokens</span>' : '') +
        (root && jobStallMs(root, now) ? jobStallBadge(root, now) : '') +
      '</div>' +
      (root && jobTaskLine(root) ? '<div class="job-head-task">' + esc(jobTaskLine(root)) + '</div>' : '') +
    '</div>' +
    (root ? jobDetailHtml(root, rootExpanded) : '');
  var phases = jobPhases(node, dataMap);
  for (var p = 0; p < phases.length; p++) html += renderJobPhase(jobId, phases[p], dataMap, now, expandedMap, openMap);
  return html + '</div>';
}

// Pure: a single background task (a root op with no workers, or an ambient op).
function renderTaskCard(rec, now, expanded) {
  var safeId = esc(rec.id);
  var o = jobOutcome(rec.status);
  var terminal = isTerminalStatus(rec.status);
  var stalled = jobStallMs(rec, now) > 0;
  var kind = isAmbientType(rec.type) && !terminal ? ambientStatusLabel(rec) : jobKindLabel(rec.type);
  var uses = jobToolUses(rec);
  var activity = terminal ? '' : jobActivityLabel(rec);
  return '<div class="job-task ' + o.cls + (stalled ? ' stalled' : '') + (expanded ? ' open' : '') + '" id="agent-row-' + safeId + '" data-agent-row="' + safeId + '">' +
      '<div class="job-task-title"><span class="job-task-icon">' + iconForType(rec.type || rec.role) + '</span><span class="job-task-name">' + esc(rec.name || rec.id) + '</span>' +
        (terminal
          ? '<button class="job-task-dismiss" title="Remove from the list" data-agent-action="dismiss" data-agent-id="' + safeId + '">&times;</button>'
          : '<button class="job-task-stop" title="Cancel this task" data-agent-action="cancel" data-agent-id="' + safeId + '">&#9633;</button>') +
      '</div>' +
      '<div class="job-task-meta">' +
        '<span class="job-task-kind">' + esc(kind) + '</span>' +
        '<span class="job-row-status ' + o.cls + '">' + esc(o.label) + '</span>' +
        '<span class="job-row-time">' + jobElapsedLabel(rec.startedAt, rec.endedAt, now) + '</span>' +
        jobStallBadge(rec, now) +
      '</div>' +
      '<div class="job-task-stats">' +
        (Number(rec.totalTokens) > 0 ? '<span class="job-task-tokens">' + formatTokens(rec.totalTokens) + ' tokens</span>' : '') +
        (uses > 0 ? '<span class="job-task-uses">' + uses + ' tool use' + (uses === 1 ? '' : 's') + '</span>' : '') +
        (activity ? '<span class="job-task-activity">' + esc(activity) + '</span>' : '') +
        '<span class="job-task-transcript">View transcript</span>' +
      '</div>' +
    '</div>' +
    jobDetailHtml(rec, expanded);
}

// Pure: the Finished drawer. '' when nothing has finished.
function renderFinishedDrawer(nodes, dataMap, now, open, expandedMap, openMap) {
  if (!nodes.length) return '';
  var items = '';
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    items += (n.kind === 'card' && !(n.children || []).length)
      ? renderTaskCard(dataMap[n.id], now, !!(expandedMap && expandedMap[n.id]))
      : renderJob(n, dataMap, now, expandedMap, openMap);
  }
  return '<div class="job-finished' + (open ? ' open' : '') + '">' +
      '<div class="job-finished-head">' +
        '<span class="job-finished-title" data-finished-toggle>Finished ' + nodes.length + ' <span class="job-phase-chevron">' + (open ? '&#9662;' : '&#9656;') + '</span></span>' +
        '<button class="job-finished-clear" title="Clear finished tasks" data-agent-action="clear-finished">&#128465;</button>' +
      '</div>' +
      '<div class="job-finished-list" style="display:' + (open ? 'block' : 'none') + '">' + items + '</div>' +
    '</div>';
}

// Pure: the whole list. `state` = { expanded, phaseOpen, ambientOpen, finishedOpen }.
function renderBackgroundTasks(dataMap, state, now) {
  var st = state || {};
  var parts = partitionAmbient(dataMap || {});
  var tree = buildAgentFeedTree(parts.main);
  var running = '', finished = [];
  for (var i = 0; i < tree.length; i++) {
    var node = tree[i];
    if (jobIsFinished(node, dataMap)) { finished.push(node); continue; }
    running += (node.kind === 'card' && !(node.children || []).length)
      ? renderTaskCard(dataMap[node.id], now, !!(st.expanded && st.expanded[node.id]))
      : renderJob(node, dataMap, now, st.expanded, st.phaseOpen);
  }
  var ambientIds = Object.keys(parts.ambient), ambientLive = '';
  for (var a = 0; a < ambientIds.length; a++) {
    var rec = parts.ambient[ambientIds[a]];
    if (isTerminalStatus(rec.status)) { finished.push({ kind: 'card', id: rec.id, children: [] }); continue; }
    ambientLive += renderTaskCard(rec, now, !!(st.expanded && st.expanded[rec.id]));
  }
  var html = running;
  if (ambientLive) {
    var aOpen = !!st.ambientOpen;
    html += '<div class="job-ambient' + (aOpen ? ' open' : '') + '">' +
      '<div class="job-ambient-head" data-ambient-toggle>Ambient <span class="job-phase-chevron">' + (aOpen ? '&#9662;' : '&#9656;') + '</span></div>' +
      '<div class="job-ambient-list" style="display:' + (aOpen ? 'block' : 'none') + '">' + ambientLive + '</div></div>';
  }
  if (!html && !finished.length) return '<div class="job-empty">No background tasks</div>';
  return html + renderFinishedDrawer(finished, dataMap, now, !!st.finishedOpen, st.expanded, st.phaseOpen);
}
