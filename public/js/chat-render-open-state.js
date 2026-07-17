// ── Chat: live-swap state carry (open/collapse + scroll) ──
//
// The live assistant bubble is rebuilt from scratch on every WS event
// (chat-render-live.js), which would wipe any group the user manually
// expanded and reset every internal scroller. These helpers capture that
// state off the old node and re-apply it to the fresh one. Split out of
// chat-render-live.js for the 400-LOC gate; loads BEFORE it (call-time
// resolution either way, but keep the dependency direction obvious).

// Carry expanded/collapsed state across the swap, matching groups/cards by
// the data-key stamp _renderAssistantToolArtifacts applies
// (toolCallId-derived) — NOT by document order: `stream replace` events
// (tool-call-from-text extraction sets content wholesale mid-turn) can
// shrink or restructure the rebuilt bubble, shifting indices so open-state
// lands on the wrong card. Keyless elements (legacy paints) still fall back
// to their index.
function preserveOpenState(oldNode, fresh) {
  for (const sel of ['.activity-group', '.tool-card']) {
    const olds = oldNode.querySelectorAll(sel);
    const news = fresh.querySelectorAll(sel);
    // One pass over each list (this runs per animation frame): collect the
    // open old elements' keys (or index when unkeyed), then match new ones.
    const openKeys = new Set();
    const openIdx = new Set();
    olds.forEach((el, i) => {
      if (!el.classList.contains('open')) return;
      if (el.dataset.key) openKeys.add(el.dataset.key);
      else openIdx.add(i);
    });
    if (!openKeys.size && !openIdx.size) continue;
    news.forEach((el, i) => {
      const open = el.dataset.key ? openKeys.has(el.dataset.key) : openIdx.has(i);
      if (!open) return;
      el.classList.add('open');
      const chev = el.querySelector('.activity-chevron');
      if (chev) chev.textContent = '▼';
    });
  }
  // Reasoning blocks are native <details> keyed per block. The BUILD decides
  // the default (trailing block open while it streams, earlier ones
  // collapsed — that auto-collapse is the point of the timeline), so only an
  // EXPLICIT user toggle overrides it: _makeReasoningDetails records clicks
  // on dataset.user, and that intent — not the raw .open attribute — is what
  // carries across the swap. Carrying .open itself would freeze the trailing
  // block open forever, defeating the auto-collapse.
  const userToggles = new Map();
  let legacyOld = null;
  oldNode.querySelectorAll('.reasoning-block').forEach(el => {
    if (el.dataset.key && el.dataset.user) userToggles.set(el.dataset.key, el.dataset.user);
    else if (!el.dataset.key) legacyOld = el;
  });
  fresh.querySelectorAll('.reasoning-block').forEach(el => {
    if (el.dataset.key) {
      const u = userToggles.get(el.dataset.key);
      if (u) { el.dataset.user = u; el.open = u === 'open'; }
    } else if (legacyOld) {
      // Legacy single flat block (no key): carry .open verbatim, matching
      // the pre-timeline behavior.
      el.open = legacyOld.open;
    }
  });
}

// The swap also rebuilds .activity-group-body (its own overflow-y scroller),
// which resets scrollTop to 0 — mid-stream that yanked the reader back to the
// first tool call on every WS event. Capture each visible body's position
// before the swap; restore AFTER the fresh node is in the document (scrollTop
// doesn't stick on detached/display:none elements). A reader parked at the
// bottom keeps following new entries as they append. Reasoning bodies get the
// same treatment, keyed off their <details> data-key — without it a long open
// Thinking block yanked the reader back to its top on every delta.
const _SCROLL_SELS = [
  { body: '.activity-group-body', keyOf: (b) => { const g = b.closest('.activity-group'); return (g && g.dataset.key) || null; } },
  { body: '.reasoning-body',      keyOf: (b) => { const d = b.closest('.reasoning-block'); return (d && d.dataset.key) || null; } },
];

function captureActivityScroll(oldNode) {
  const saved = [];
  for (const sel of _SCROLL_SELS) {
    oldNode.querySelectorAll(sel.body).forEach((body, i) => {
      if (!body.clientHeight) return;
      saved.push({
        sel: sel.body,
        key: sel.keyOf(body),
        i,
        top: body.scrollTop,
        atBottom: body.scrollTop + body.clientHeight >= body.scrollHeight - 8,
      });
    });
  }
  return saved;
}

function restoreActivityScroll(fresh, saved) {
  if (!saved.length) return;
  for (const sel of _SCROLL_SELS) {
    const entries = saved.filter(s => s.sel === sel.body);
    if (!entries.length) continue;
    const bodies = fresh.querySelectorAll(sel.body);
    // Key → body map so each restore stays O(1) on the per-frame swap path.
    const byKey = new Map();
    bodies.forEach((body) => {
      const key = sel.keyOf(body);
      if (key && !byKey.has(key)) byKey.set(key, body);
    });
    for (const s of entries) {
      // A keyed capture must NOT fall back to index — landing the scroll on
      // a different group is worse than dropping it (fresh bodies start at
      // 0, which reads as "new group", not as a jump).
      const body = s.key ? byKey.get(s.key) : bodies[s.i];
      if (body) body.scrollTop = s.atBottom ? body.scrollHeight : s.top;
    }
  }
}
