// ── Agent Feeds — card HTML ──
// Pure HTML producers. No DOM lookups, no state mutations — given an
// agent record, return the markup. Wired into chat-agent-feeds.js (panel
// list) and chat-send-http.js (inline agent-spawn/agent-status events).

// Icon lookup for a worker card. Two disjoint key spaces share one table:
//   • ROLE keys (researcher/writer/coder/…) — used by the inline named-agent
//     card (renderAgentCard_inline), where `agent.role` is a real specialist.
//   • OP-TYPE keys (app_build/research/self_edit/…) — used by the right-rail
//     panel card, which keys off the op's real `type` (threaded through the
//     bg_op_queued/started events as `opType`). Before this, every panel card
//     showed the same 'coder' 💻 because role was hardcoded server-side.
// Op-type glyphs are tasteful monochrome symbols (not loud emoji) to sit
// quietly in the mission-control rail. Unknown keys fall back to DEFAULT_AGENT_ICON.
const DEFAULT_AGENT_ICON = '🤖';
const AGENT_ROLE_ICONS = {
  // roles (inline specialist cards)
  researcher: '🔍', writer: '✍️', coder: '💻',
  reviewer: '🔎', 'social-media': '📱', analyst: '📊',
  monitor: '👁️', designer: '🎨', ops: '⚙️',
  communicator: '📨',
  // op types (right-rail panel cards) — monochrome glyphs
  app_build: '⬡', build_app: '⬡', research: '◎', research_query: '◎',
  self_edit: '✎', refactor: '⟳', autopilot: '➤', freeform: '✦',
  agent: '◇', agent_spawn: '◇', scheduled_mission: '◷',
  // forward-looking placeholders (inert until these op types exist):
  dream: '☾', idle: '☾'
};

// Pure: map an op type (or role) to its glyph, with a clean generic default
// for unknown/absent keys. Keyed by the same AGENT_ROLE_ICONS table so a card
// can pass `agent.type || agent.role` and get the type's icon when present,
// the role's icon otherwise, and the default when neither is known.
function iconForType(type) {
  return AGENT_ROLE_ICONS[type] || DEFAULT_AGENT_ICON;
}

// Pure: does this status put a card in a TERMINAL (finished) state? Matches the
// existing status vocabulary (the .agent-feed-card terminal CSS classes +
// bg_op_completed's completed/failed/cancelled). Terminal cards fold to a
// compact one-line row (the "calm" feature); working/waiting/paused/queued
// cards stay full. Case/space tolerant so a 'queued #3' never reads terminal.
const TERMINAL_AGENT_STATUSES = {
  completed: 1, done: 1, succeeded: 1, failed: 1, cancelled: 1, error: 1
};
function isTerminalStatus(status) {
  return !!TERMINAL_AGENT_STATUSES[String(status == null ? '' : status).trim().toLowerCase()];
}

// Pure: decide a card's folded state AFTER an update, so updateAgentFeed's
// className rewrite doesn't wipe the fold. A card folds by DEFAULT the moment
// it FIRST goes terminal; once terminal we preserve whatever fold/expand the
// user last set — a late trailing event must never pop a finished card open.
//   nowTerminal  — isTerminalStatus(new status)
//   prevTerminal — was the card already terminal before this update
//   prevFolded   — did the card carry the `folded` class before this update
function foldedAfterUpdate(nowTerminal, prevTerminal, prevFolded) {
  if (nowTerminal && !prevTerminal) return true; // first terminal render → fold
  return !!prevFolded;                           // preserve user's / prior state
}

// ── C6: run-lineage tree build (PURE) ──
// Input:  the agentFeedsData map ({ id → agent record }).
// Output: an ordered array of top-level render nodes:
//   { kind: 'card',  id, children: [node...] }         — a real worker card
//                                                         (+ any card-children
//                                                          nested under it)
//   { kind: 'group', parentOpId, count, children: [...] } — a SYNTHETIC
//                                                         fan-out header for ≥2
//                                                         root cards sharing the
//                                                         same non-card parentOpId
// A card whose parentOpId points to another CARD nests under that card. A card
// whose parentOpId is absent or points to a NON-card (e.g. the chat turn that
// launched a batch — not itself a card) is a ROOT. Roots that share the same
// non-card parent (≥2) collapse under one synthetic group; a lone such root
// stays a plain root (no wrapper).
//
// Guarantees (see unit test chat-agent-feeds-tree.test.ts):
//   - every card appears EXACTLY once (as a root, a child, or — if stranded in
//     a parentOpId cycle — surfaced as a top-level card by the leftover sweep),
//     never dropped, never doubled;
//   - a cycle (A→B→A) can't infinite-loop — a `visited` set breaks it.
// Pure: reads only its `dataMap` argument, touches no DOM/global — so it is
// unit-testable by loading this file in a Function factory (happy-dom). Lives
// here (not in chat-agent-feeds.js) so that file stays under the 400-LOC gate.
function buildAgentFeedTree(dataMap) {
  var map = dataMap || {};
  var ids = Object.keys(map);
  var isCard = {};
  var i;
  for (i = 0; i < ids.length; i++) isCard[ids[i]] = true;

  // childMap: card-parent id → [child id, …], only for parents that ARE cards.
  var childMap = {};
  var rootIds = [];
  for (i = 0; i < ids.length; i++) {
    var id = ids[i];
    var rec = map[id] || {};
    var p = rec.parentOpId;
    if (p && isCard[p] && p !== id) {
      (childMap[p] || (childMap[p] = [])).push(id);
    } else {
      // No parent, self-parent, or a non-card parent → this is a root.
      rootIds.push(id);
    }
  }

  var visited = {};
  function buildCardNode(cardId) {
    if (visited[cardId]) return null;   // cycle / already placed elsewhere
    visited[cardId] = true;
    var kids = childMap[cardId] || [];
    var childNodes = [];
    for (var k = 0; k < kids.length; k++) {
      var cn = buildCardNode(kids[k]);
      if (cn) childNodes.push(cn);
    }
    return { kind: 'card', id: cardId, children: childNodes };
  }

  // Order roots, grouping those that share the same non-card parentOpId.
  var groupMembers = {};   // non-card parentOpId → [root id, …]
  var order = [];          // preserves first-seen order of roots/groups
  for (i = 0; i < rootIds.length; i++) {
    var rid = rootIds[i];
    var pp = (map[rid] || {}).parentOpId;
    if (pp && !isCard[pp]) {
      if (!groupMembers[pp]) { groupMembers[pp] = []; order.push({ t: 'group', key: pp }); }
      groupMembers[pp].push(rid);
    } else {
      order.push({ t: 'card', key: rid });
    }
  }

  var nodes = [];
  for (i = 0; i < order.length; i++) {
    var ent = order[i];
    if (ent.t === 'card') {
      var node = buildCardNode(ent.key);
      if (node) nodes.push(node);
    } else {
      var members = groupMembers[ent.key];
      var memberNodes = [];
      for (var m = 0; m < members.length; m++) {
        var mn = buildCardNode(members[m]);
        if (mn) memberNodes.push(mn);
      }
      if (memberNodes.length >= 2) {
        nodes.push({ kind: 'group', parentOpId: ent.key, count: memberNodes.length, children: memberNodes });
      } else if (memberNodes.length === 1) {
        // Lone worker with a non-card parent → plain root, no synthetic wrapper.
        nodes.push(memberNodes[0]);
      }
    }
  }

  // Leftover sweep: any card never visited is stranded in a parentOpId cycle
  // (e.g. A→B→A, where neither is a root). Surface it as a top-level card so
  // it still renders exactly once rather than vanishing.
  for (i = 0; i < ids.length; i++) {
    if (!visited[ids[i]]) {
      var orphan = buildCardNode(ids[i]);
      if (orphan) nodes.push(orphan);
    }
  }

  return nodes;
}

// childrenHtml (optional): pre-rendered markup for cards spawned BY this
// worker (parentOpId === this card's id), from C6 run-lineage nesting.
// When present, the card is wrapped in an `.agent-feed-branch` and the
// children ride in a SIBLING `.agent-feed-children` container — NOT inside
// `#agent-card-<id>` — so updateAgentFeed's `card.querySelector('.worker-*')`
// targeted writes and the 1s resync only ever touch THIS card's own body,
// never a nested child's. When absent, the returned markup is byte-identical
// to the pre-nesting flat card (keeps the flat-list path unchanged).
function renderAgentCard(agent, childrenHtml) {
  // Icon keys off the op's real TYPE (threaded via bg_op_* opType → the card
  // record's `type`), falling back to the legacy `role` then a generic default.
  var icon = iconForType(agent.type || agent.role);
  var status = agent.status || 'working';
  var streamText = agent.streamText || '';
  var output = agent.output || '';
  var outputLines = output.split('\n').filter(function(l) { return l.trim().length > 0; });
  var initialToolCount = outputLines.length;
  var latestLine = outputLines.length > 0 ? outputLines[outputLines.length - 1] : '';
  var isPaused = status === 'paused';
  // Terminal cards fold to a one-line row by default (the "calm" feature). The
  // full body stays in the DOM (CSS hides it) so updateAgentFeed's targeted
  // writes + the 1s resync never miss their selectors — a late trailing event
  // must not throw or pop a finished card open. `data-terminal` lets the CSS
  // show the pointer/chevron affordance and lets updateAgentFeed preserve the
  // user's manual fold/expand across late re-renders.
  var terminal = isTerminalStatus(status);
  var isActive = !terminal;
  var foldedClass = terminal ? ' folded' : '';
  var termAttr = terminal ? '1' : '0';
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
  var cardHtml = '<div id="agent-card-' + safeId + '" class="agent-feed-card ' + status + foldedClass + '" data-terminal="' + termAttr + '">' +
    '<div class="agent-feed-header">' +
      '<span class="agent-feed-icon">' + icon + '</span>' +
      '<span class="agent-feed-name">' + esc(agent.name || agent.id) + '</span>' +
      '<span class="agent-feed-status"><span class="agent-status-dot"></span> ' + esc(status) + '</span>' +
      '<button class="agent-feed-dismiss" title="Dismiss card (does not cancel)" data-agent-action="dismiss" data-agent-id="' + safeId + '">×</button>' +
    '</div>' +
    '<div class="worker-latest" style="padding:.25rem .55rem;font-family:var(--mono,monospace);font-size:.68rem;color:var(--muted,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid var(--border,#333);min-height:1.2em">' + esc(latestLine) + '</div>' +
    '<div class="worker-text" style="white-space:pre-wrap;font-size:.78rem;line-height:1.35;color:var(--text,#ddd);padding:.4rem .55rem;max-height:240px;overflow-y:auto">' + esc(streamText) + '</div>' +
    '<div class="worker-tools-group' + bodyOpenClass + '" style="border-top:1px solid var(--border,#333);background:rgba(0,0,0,0.18)">' +
      '<div class="worker-tools-header" data-agent-toggle="tools" style="cursor:pointer;padding:.35rem .55rem;display:flex;align-items:center;gap:.4rem;font-size:.7rem;color:var(--muted,#888);user-select:none">' +
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
        ? '<button class="agent-ctrl-btn" data-agent-action="resume" data-agent-id="' + safeId + '">Resume</button>'
        : '<button class="agent-ctrl-btn" data-agent-action="pause" data-agent-id="' + safeId + '">Pause</button>') +
      '<button class="agent-ctrl-btn" data-agent-action="redirect" data-agent-id="' + safeId + '">Redirect</button>' +
      '<button class="agent-ctrl-btn" title="This should have been a chat reply, not a worker. Kills this op and re-asks inline." data-agent-action="stayinline" data-agent-id="' + safeId + '">Stay inline</button>' +
      '<button class="agent-ctrl-btn cancel" data-agent-action="cancel" data-agent-id="' + safeId + '">Cancel</button>' +
    '</div>' +
    '<input class="agent-redirect-input" id="agent-redirect-' + safeId + '" data-agent-redirect="' + safeId + '" placeholder="New instructions..." />' +
  '</div>';
  // No children → return the flat card unchanged (identical to pre-C6).
  if (!childrenHtml) return cardHtml;
  // Children present → wrap card + a sibling `.agent-feed-children` branch,
  // mirroring org-chart's `.org-branch` / `.org-children`. The card id stays
  // a direct, clean `#agent-card-<id>` node; nested cards live outside it.
  return '<div class="agent-feed-branch">' + cardHtml +
    '<div class="agent-feed-children">' + childrenHtml + '</div>' +
  '</div>';
}

// Synthetic "fan-out" group header for the C6 run-lineage tree: when ≥2
// root worker cards share the same NON-card parentOpId (e.g. the chat turn
// that launched a batch — which is itself not a worker card), they render
// nested under one lightweight header so a fan-out reads as one tree
// (supervisor → workers) instead of a flat list. This is NOT an
// `.agent-feed-card` and carries no id, so it is never counted by
// _updateAgentCount and never picked up by updateAgentFeed's targeted
// DOM writes. `count` = number of direct sibling worker cards.
function renderAgentFeedGroup(parentOpId, count, childrenHtml) {
  return '<div class="agent-feed-group">' +
    '<div class="agent-feed-group-header">' +
      '<span class="agent-feed-group-icon">🎯</span>' +
      '<span class="agent-feed-group-title">Fan-out</span>' +
      '<span class="agent-feed-group-count">' + Number(count || 0) + ' agents</span>' +
    '</div>' +
    '<div class="agent-feed-children">' + (childrenHtml || '') + '</div>' +
  '</div>';
}

function renderAgentCard_inline(agent) {
  var icon = AGENT_ROLE_ICONS[agent.role] || '🤖';
  var status = agent.status || 'working';
  var progress = agent.progress || '';
  return '<div class="agent-inline-card" data-agent-id="' + esc(agent.id) + '">' +
    '<span class="agent-inline-icon">' + icon + '</span>' +
    '<span class="agent-inline-name">' + esc(agent.name || agent.id) + '</span>' +
    '<span class="agent-inline-status">' + esc(status) + '</span>' +
    (progress ? '<span class="agent-inline-progress">' + esc(progress) + '</span>' : '') +
  '</div>';
}
