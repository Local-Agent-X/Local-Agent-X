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
  { body: '.activity-group-body', unseen: true, keyOf: (b) => { const g = b.closest('.activity-group'); return (g && g.dataset.key) || null; } },
  { body: '.reasoning-body',      unseen: false, keyOf: (b) => { const d = b.closest('.reasoning-block'); return (d && d.dataset.key) || null; } },
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

// How far down each activity group the reader has actually caught up: the
// activity total as of the last frame they were parked at the bottom of that
// group's scroller.
//
// It lives HERE, in module state keyed by the group's stable data-key, and not
// on the group node, because the node is thrown away on every WS event and the
// capture that would ferry it is gated on layout (`!body.clientHeight`). That
// is zero for a whole class of ordinary frames — the Chat route hidden behind
// .page{display:none} while the reader checks Settings, or the group collapsed
// for one frame — and _paintLiveSwap keeps swapping through all of them. A
// node-stamped carry therefore vanished after ONE such frame and silently
// re-derived "fully seen": the reader came back and was told nothing had
// landed. Keyed state survives those frames; nothing about it is derived from
// "this node was just created".
const _SEEN_MAX = 200;
const _seenByGroup = new Map();
function _rememberSeen(key, seen) {
  if (!key) return;
  // Re-insert so the size cap evicts the least recently touched group, not the
  // longest-running one.
  _seenByGroup.delete(key);
  _seenByGroup.set(key, seen);
  while (_seenByGroup.size > _SEEN_MAX) _seenByGroup.delete(_seenByGroup.keys().next().value);
}
// NaN when this group has never been tracked (first paint, or one the reader
// just expanded) — which reads as "fully seen", so the badge only ever reports
// growth the reader demonstrably missed.
function _recallSeen(key) {
  const v = key ? _seenByGroup.get(key) : undefined;
  return Number.isFinite(v) ? v : NaN;
}

function _activityTotal(group) {
  const el = group.querySelector('.activity-count');
  return el ? (parseInt(el.getAttribute('data-total') || '0', 10) || 0) : 0;
}

// Below-the-fold counter. Staying parked is the CORRECT behavior — yanking a
// reader who deliberately scrolled up is its own bug — but it means every card
// that lands while they're parked is invisible, which is how a 34-call tool
// loop read as frozen. So count them instead. Called once per restored group,
// with the position that group's capture recorded.
function _carryUnseen(group, atBottom) {
  const key = group.dataset.key || null;
  const total = _activityTotal(group);
  const prev = _recallSeen(key);
  // Clamp to the CURRENT total: a `stream replace` can restructure and shrink
  // the rebuilt bubble (see the note above preserveOpenState), and a
  // stale-high `seen` would then suppress every later action's badge forever.
  const seen = (atBottom || !Number.isFinite(prev)) ? total : Math.min(prev, total);
  _rememberSeen(key, seen);
  _showUnseen(group, total, seen);
}

// The badge lives in the group's always-visible status line (built by
// ensureActivityGroup in chat-tool-cards.js). It counts ACTIONS, and says so:
// consecutive same-tool calls collapse into one ×N card, so "↓ 34 new" over a
// single card would promise 34 things to scroll to that do not exist. Clicking
// it jumps to the newest card — an offer the reader takes, never an automatic
// scroll — and catches them up THERE AND THEN, because a finished turn has no
// next frame to clear the badge with. The listener is attached per element
// instance; the group is rebuilt every frame, so the guard only matters if one
// node is painted twice.
function _showUnseen(group, total, seen) {
  const el = group.querySelector('.activity-unseen');
  if (!el) return;
  const n = Math.max(0, total - seen);
  if (n < 1) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = '';
  el.textContent = '↓ ' + n + (n === 1 ? ' new action' : ' new actions');
  el.title = 'Jump to the newest activity';
  if (el.dataset.wired) return;
  el.dataset.wired = '1';
  el.addEventListener('click', () => {
    const body = group.querySelector('.activity-group-body');
    if (body) body.scrollTop = body.scrollHeight;
    _carryUnseen(group, true);
  });
}

function restoreActivityScroll(fresh, saved) {
  const painted = new Set();
  for (const sel of _SCROLL_SELS) {
    const entries = (saved || []).filter(s => s.sel === sel.body);
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
      if (!body) continue;
      body.scrollTop = s.atBottom ? body.scrollHeight : s.top;
      if (!sel.unseen) continue;
      const group = body.closest('.activity-group');
      if (!group) continue;
      painted.add(group);
      _carryUnseen(group, s.atBottom);
    }
  }
  // Every OTHER expanded group repaints from the remembered progress. A group
  // whose body had no layout on the previous frame produces no capture entry at
  // all, so without this pass the fresh node would render an empty badge and
  // the reader would be told nothing landed while they were away. Nothing is
  // re-recorded here — nobody scrolled. Collapsed groups are skipped: they have
  // no fold to be below and no scroller to jump into, so the header line and
  // the count digit carry the whole story. Nothing tracked yet (a turn with no
  // tool calls, the common case) costs this path nothing at all.
  if (!_seenByGroup.size) return;
  fresh.querySelectorAll('.activity-group').forEach(group => {
    if (painted.has(group) || !group.classList.contains('open')) return;
    const seen = _recallSeen(group.dataset.key || null);
    if (!Number.isFinite(seen)) return;
    const total = _activityTotal(group);
    _showUnseen(group, total, Math.min(seen, total));
  });
}
