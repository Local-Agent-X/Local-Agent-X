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
  app_build: '⬡', build_app: '⬡', app_builder: '⬡',
  self_edit: '✎', refactor: '⟳', autopilot: '➤', freeform: '✦',
  agent: '◇', agent_spawn: '◇',
  // AMBIENT background ops (docked in their own quiet corner, see partitionAmbient):
  // dream = memory_consolidation (☾ crescent), research/cron = scheduled_mission
  // (◎ scanning lens). Replaces the dead dream/idle/research/research_query keys —
  // nothing was ever typed those; these are the real op types the server emits.
  memory_consolidation: '☾', scheduled_mission: '◎',
  // SUPERVISOR / tree-root: the auto-build orchestrator (and any op that spawns
  // & directs its own workers). ◈ reads as a hub/root and is deliberately
  // distinct from ◇ (a leaf agent) so the supervisor never looks like a worker.
  orchestrator: '◈', supervisor: '◈'
};

// Pure: map an op type (or role) to its glyph, with a clean generic default
// for unknown/absent keys. Keyed by the same AGENT_ROLE_ICONS table so a card
// can pass `agent.type || agent.role` and get the type's icon when present,
// the role's icon otherwise, and the default when neither is known.
function iconForType(type) {
  return AGENT_ROLE_ICONS[type] || DEFAULT_AGENT_ICON;
}

// ── Token meter (PURE) ──
// The per-op running token total surfaces as a thin bar + a compact label on
// each worker card. Both helpers are pure so they unit-test headlessly next to
// iconForType (chat-agent-feeds-icon-fold.test.ts). The bar element is always
// present in the card markup so updateAgentFeed's targeted writes can fill it
// live; it simply stays at 0 (label blank) for cards that never report usage.
//
// formatTokens — compact human label. <1000 → the bare integer; ≥1000 → one
//   decimal "k" (12100 → "12.1k"); ≥1,000,000 → one decimal "M" (a job's
//   roll-up). tabular-nums in the CSS keeps the digits from reflowing.
function formatTokens(n) {
  var t = Number(n) || 0;
  if (t < 0) t = 0;
  if (t < 1000) return String(Math.round(t));
  if (t < 1000000) return (t / 1000).toFixed(1) + 'k';
  return (t / 1000000).toFixed(1) + 'M';
}

// tokenBarFillPct — map a running total to a bar-fill percentage [0..100].
// Linear against a fixed SOFT reference (TOKEN_BAR_REF): the number label is
// the source of truth, the bar is only a glanceable cue, so it saturates at the
// reference rather than overflowing — a runaway op reads "full" instead of
// blowing out the layout. 50k picked so a typical multi-turn worker fills a
// meaningful fraction without one big op pinning every bar at 100%.
var TOKEN_BAR_REF = 50000;
function tokenBarFillPct(n) {
  var t = Number(n) || 0;
  if (t <= 0) return 0;
  var pct = (t / TOKEN_BAR_REF) * 100;
  return pct > 100 ? 100 : pct;
}

// Pure: does this status put a card in a TERMINAL (finished) state? Matches the
// existing status vocabulary (the .agent-feed-card terminal CSS classes +
// bg_op_completed's completed/failed/cancelled). Terminal cards fold to a
// compact one-line row (the "calm" feature); working/waiting/paused/queued
// cards stay full. Case/space tolerant so a 'queued #3' never reads terminal.
// `partial` (stopped at a checkpoint, work saved but unfinished) IS terminal:
// the op is over and its controls (pause/redirect/cancel) can no longer act.
const TERMINAL_AGENT_STATUSES = {
  completed: 1, done: 1, succeeded: 1, failed: 1, cancelled: 1, error: 1, partial: 1
};
function isTerminalStatus(status) {
  return !!TERMINAL_AGENT_STATUSES[String(status == null ? '' : status).trim().toLowerCase()];
}

// Single owner of the control row. Both the initial render and
// updateAgentFeed's targeted rewrite call this — they used to carry separate
// copies of the markup, which had already drifted (the rewrite silently
// dropped "Stay inline").
//
// Terminal cards get NO controls. Pause/Redirect/Cancel against a finished op
// cannot succeed: opRedirect returns not-running and the card's redirect input
// would accept text, clear itself and look exactly like a delivered message.
function renderAgentCardControls(safeId, status) {
  if (isTerminalStatus(status)) return '';
  const paused = status === 'paused' || status === 'blocked' || status === 'stalled';
  return (paused
      ? '<button class="agent-ctrl-btn" data-agent-action="resume" data-agent-id="' + safeId + '">Resume</button>'
      : '<button class="agent-ctrl-btn" data-agent-action="pause" data-agent-id="' + safeId + '">Pause</button>') +
    '<button class="agent-ctrl-btn" data-agent-action="redirect" data-agent-id="' + safeId + '">Redirect</button>' +
    '<button class="agent-ctrl-btn" title="This should have been a chat reply, not a worker. Kills this op and re-asks inline." data-agent-action="stayinline" data-agent-id="' + safeId + '">Stay inline</button>' +
    '<button class="agent-ctrl-btn cancel" data-agent-action="cancel" data-agent-id="' + safeId + '">Cancel</button>';
}

// Result-link markup for a URL-producing op (build_app URL, cron report, …).
// Single chokepoint shared by updateAgentFeed's live write and renderAgentCard,
// so the link renders identically live and across full re-renders
// (chat-switch used to silently drop it).
//
// /api/* and loopback URLs need the auth token appended — Electron child
// windows (and external browser tabs) don't carry the parent's Authorization
// header, so a bare /api/cron/.../reports/latest 401's. The server accepts
// ?token=<bearer> as an equivalent to Authorization: Bearer. Live failure
// 2026-05-19: user clicked the worker's report link and got "Unauthorized".
// Label shows the BARE url (no token leakage); href gets the authed variant.
// esc() on the href guards against any agent-controlled string reaching it.
function resultLinkHtml(rawUrl) {
  // Agent-built apps and files are served off this origin and never take the
  // operator token (src/server/agent-origin.ts); a /files link gets the
  // files-link capability instead (agentFilesHref, shared-md.js).
  var agentContent = /^(https?:\/\/[^/]+)?\/(apps|dashboards|files)\//.test(rawUrl);
  // Only this UI's own origin gets the token: the agent chooses resultUrl
  // (any "Open: <url>" line in a tool result), so another loopback port may
  // be a listener it started.
  var ownOrigin = false;
  try { ownOrigin = new URL(rawUrl, location.href).origin === location.origin; } catch (_) {}
  var needsAuth = !agentContent && ownOrigin;
  var token = (typeof AUTH_TOKEN !== 'undefined' && AUTH_TOKEN) ? AUTH_TOKEN : (localStorage.getItem('lax_token') || '');
  var authedUrl = (needsAuth && token && rawUrl.indexOf('token=') === -1)
    ? rawUrl + (rawUrl.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token)
    : (agentContent ? agentFilesHref(rawUrl) : rawUrl);
  return '<a href="' + esc(authedUrl) + '" target="_blank" rel="noopener" style="color:var(--accent,#3a7);text-decoration:none">↗ Open: ' + esc(rawUrl) + '</a>';
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

// The detail under a jobs-layout row (chat-agent-feeds-jobs.js). The row owns
// the name, status and elapsed time, so the card is body only: the latest
// activity line, the worker's own text, the collapsible tool trace, the token
// meter, the result link, the controls and the redirect input. Every element
// keeps the selector updateAgentFeed and the 1s sync write to.
function renderAgentCard(agent) {
  var isSupervisor = agent.type === 'orchestrator' || agent.type === 'supervisor';
  var status = agent.status || 'working';
  var streamText = agent.streamText || '';
  var output = agent.output || '';
  var outputLines = output.split('\n').filter(function(l) { return l.trim().length > 0; });
  var initialToolCount = outputLines.length;
  var latestLine = outputLines.length > 0 ? outputLines[outputLines.length - 1] : '';
  // `data-terminal` lets sendAgentRedirect refuse an instruction to a finished op.
  var terminal = isTerminalStatus(status);
  var isActive = !terminal;
  var safeId = esc(agent.id);
  // The tool trace defaults to OPEN while the worker is live so the full
  // stream shows without a click, and closed once it has finished.
  var bodyDisplay = isActive ? 'block' : 'none';
  var bodyOpenClass = isActive ? ' open' : '';
  var chevron = isActive ? '▼' : '▶';
  // Token meter: blank label until real usage arrives, never a misleading "0 tok".
  var tokTotal = agent.totalTokens;
  var tokLabel = (tokTotal != null && Number(tokTotal) > 0) ? (formatTokens(tokTotal) + ' tok') : '';
  return '<div id="agent-card-' + safeId + '" class="agent-feed-card ' + status + (isSupervisor ? ' supervisor' : '') + '" data-terminal="' + (terminal ? '1' : '0') + '">' +
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
    '<div class="worker-token-row" style="display:flex;align-items:center;gap:.5rem;padding:.3rem .55rem;border-top:1px solid var(--border,#333)">' +
      '<div class="worker-token-bar" style="flex:1;height:3px;border-radius:2px;background:var(--border,#333);overflow:hidden">' +
        '<div class="worker-token-bar-fill" style="height:100%;width:' + tokenBarFillPct(tokTotal) + '%;background:var(--accent,#3a7);border-radius:2px;transition:width .3s ease"></div>' +
      '</div>' +
      '<span class="worker-token-count" style="font-variant-numeric:tabular-nums;font-family:var(--mono,monospace);font-size:.62rem;color:var(--muted,#888);white-space:nowrap;min-width:2.5em;text-align:right">' + esc(tokLabel) + '</span>' +
    '</div>' +
    '<div class="agent-feed-result-link" style="display:' + (agent.resultUrl ? 'block' : 'none') + ';padding:.4rem .55rem;font-size:.75rem;border-top:1px solid var(--border,#333)">' + (agent.resultUrl ? resultLinkHtml(agent.resultUrl) : '') + '</div>' +
    '<div class="agent-feed-controls">' + renderAgentCardControls(safeId, status) + '</div>' +
    '<input class="agent-redirect-input" id="agent-redirect-' + safeId + '" data-agent-redirect="' + safeId + '" placeholder="New instructions..." />' +
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

// AMBIENT_OP_TYPES / isAmbientType / partitionAmbient / ambientStatusLabel live
// in chat-agent-feeds-ambient.js; the jobs layout (header, phase tables, rows,
// Finished drawer) in chat-agent-feeds-jobs.js. Both load after this file.
