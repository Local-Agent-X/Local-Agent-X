// ── Agent Feeds — AMBIENT dock (dream / cron cards) ──
// Pure HTML producers for the background-op corner of the agents panel,
// split out of chat-agent-feeds-render.js (400-LOC gate). Same rules: no DOM
// lookups, no state mutations. Uses the render file's globals (iconForType,
// isTerminalStatus, resultLinkHtml) + shared-escape's esc via the classic
// <script> lexical environment — load order in app.html: render → this →
// feeds core.
//
// Dream = memory_consolidation, research/cron = scheduled_mission.

const AMBIENT_OP_TYPES = { memory_consolidation: 1, scheduled_mission: 1 };
function isAmbientType(type) { return !!AMBIENT_OP_TYPES[type]; }

// Pure: split the feeds map into { ambient, main } by op type. MAIN feeds
// buildAgentFeedTree unchanged (byte-identical when no ambient agents exist).
function partitionAmbient(dataMap) {
  var map = dataMap || {}, ambient = {}, main = {}, ids = Object.keys(map);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i], rec = map[id] || {};
    if (isAmbientType(rec.type)) ambient[id] = rec; else main[id] = rec;
  }
  return { ambient: ambient, main: main };
}

// Compact ambient "activity" word (dream → dreaming, cron → scanning). Static
// per type; the card's className-driven dim + dot convey running-vs-finished.
function ambientStatusLabel(agent) {
  if (agent.type === 'memory_consolidation') return 'dreaming';
  if (agent.type === 'scheduled_mission') return 'scanning';
  return agent.status || 'ambient';
}

// Compact AMBIENT card — a minimal *variant* of renderAgentCard (not a fork):
// same iconForType glyph, `agent-card-<id>` id, `.agent-status-dot` + dismiss
// contract (updateAgentFeed / removeAgentFeed keep working untouched). Label is
// `.ambient-status` (NOT `.agent-feed-status`) so the status write can't
// clobber the "dreaming"/"scanning" word.
//
// The card carries a fold body — `.worker-latest` (single-line liveness
// preview), `.worker-tools-body` (full activity trace) and
// `.agent-feed-result-link` (mission report) — using the SAME selectors
// updateAgentFeed targets, so live writes land without any ambient-specific
// update path. Field report 2026-07-06: the old header-only card made a
// click a dead end — no path to the mission's output or report.
//
// Folded by DEFAULT (the compact dock look); the `ambient` class lets the
// header-click handler toggle the fold at ANY status (main cards only fold
// once terminal). `expanded` (from the caller's ambientExpanded map) survives
// full re-renders of the dock.
function renderAmbientCard(agent, expanded) {
  var icon = iconForType(agent.type || agent.role);
  var status = agent.status || 'working';
  var safeId = esc(agent.id);
  var output = agent.output || '';
  var outputLines = output.split('\n').filter(function(l) { return l.trim().length > 0; });
  var latestLine = outputLines.length > 0 ? outputLines[outputLines.length - 1] : '';
  return '<div id="agent-card-' + safeId + '" class="agent-feed-card ambient ' + status + (expanded ? '' : ' folded') + '" data-terminal="' + (isTerminalStatus(status) ? '1' : '0') + '">' +
    '<div class="agent-feed-header">' +
      '<span class="agent-feed-icon">' + icon + '</span>' +
      '<span class="agent-feed-name">' + esc(agent.name || agent.id) + '</span>' +
      '<span class="ambient-status"><span class="agent-status-dot"></span> ' + esc(ambientStatusLabel(agent)) + '</span>' +
      '<button class="agent-feed-dismiss" title="Dismiss card (does not cancel)" data-agent-action="dismiss" data-agent-id="' + safeId + '">×</button>' +
    '</div>' +
    '<div class="worker-latest" style="padding:.25rem .55rem;font-family:var(--mono,monospace);font-size:.68rem;color:var(--muted,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1.2em">' + esc(latestLine) + '</div>' +
    '<div class="worker-tools-body" style="font-family:var(--mono,monospace);font-size:.68rem;color:var(--muted,#888);padding:.3rem .55rem .45rem;max-height:160px;overflow-y:auto;white-space:pre-wrap;border-top:1px solid var(--border,#333)">' + esc(output) + '</div>' +
    '<div class="agent-feed-result-link" style="display:' + (agent.resultUrl ? 'block' : 'none') + ';padding:.4rem .55rem;font-size:.72rem;border-top:1px solid var(--border,#333)">' + (agent.resultUrl ? resultLinkHtml(agent.resultUrl) : '') + '</div>' +
  '</div>';
}

// Pure: full innerHTML for the AMBIENT dock; '' when empty so the caller hides
// the whole region (no stray header). Ambient cards are flat — they never
// nest. `expandedMap` ({ id → truthy }) preserves user-expanded cards across
// the full innerHTML rebuilds _renderAgentFeedsList does on every add.
function renderAmbientRegion(ambient, expandedMap) {
  var map = ambient || {}, open = expandedMap || {}, ids = Object.keys(map);
  if (ids.length === 0) return '';
  var cards = '';
  for (var i = 0; i < ids.length; i++) cards += renderAmbientCard(map[ids[i]], !!open[ids[i]]);
  return '<div class="agent-feeds-ambient-header"><span class="agent-feeds-ambient-title">Ambient</span></div>' +
    '<div class="agent-feeds-ambient-list">' + cards + '</div>';
}
