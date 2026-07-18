// ── Agent Feeds: right-rail drag-to-resize + persist ──
//
// The Agents panel (#agent-feeds) opens to a mode-aware responsive width: about
// one-third of the window for ordinary tabs and about two-thirds for Browser.
// A thin handle on the panel's inner edge lets the user resize it; ordinary and
// Browser choices persist independently and are read by toggleAgentFeeds via
// getAgentFeedsWidth().
//
// Why this is a self-contained sibling rather than reusing apps-ide-resize.js:
// that component's restore() force-applies the saved width to its panels on
// PAGE LOAD, which suits the always-visible IDE panels but would force this
// collapsed-by-default panel open on every reload. Here the width is applied
// only by the toggle (on open), and the toggle must read the persisted width
// itself. We still mirror apps-ide-resize's conventions (setPointerCapture,
// .dragging class, a body resize class, and dblclick-to-reset).
//
// Loaded alongside chat-agent-feeds.js in app.html. Both are browser global
// scripts; toggleAgentFeeds only *calls* getAgentFeedsWidth at interaction
// time (long after all scripts parse), so cross-file load order is not tight.

var AGENT_FEEDS_MIN = 260, AGENT_FEEDS_DEFAULT = 320;
var AGENT_FEEDS_DEFAULT_RATIO = 0.33, AGENT_FEEDS_BROWSER_RATIO = 0.62;
var AGENT_FEEDS_WIDTH_KEY = 'lax_agent_feeds_width';
var AGENT_FEEDS_BROWSER_WIDTH_KEY = 'lax_browser_panel_width';

// Ceiling of last resort — used only when there is no viewport to measure
// (headless tests, pre-layout). The real ceiling is agentFeedsMaxWidth().
var AGENT_FEEDS_MAX = 720;

// The panel may grow until only this much chat column is left. The BROWSER tab
// wants to run near-fullscreen while the user talks to the agent about what's
// on screen, so the ceiling is the viewport minus the chat minimum minus the
// nav sidebar (only while it's open) — closing the left pane hands its width
// straight to the panel, which is the point of the workflow. A fixed 720 cap
// made "near-fullscreen" impossible on any large monitor.
var CHAT_MIN_VISIBLE = 360;

function agentFeedsMaxWidth() {
  var vw = 0;
  try { vw = window.innerWidth || 0; } catch (e) {}
  if (!vw) return AGENT_FEEDS_MAX;
  var reserved = CHAT_MIN_VISIBLE;
  try {
    var sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('collapsed')) {
      reserved += sidebar.getBoundingClientRect().width || 0;
    }
  } catch (e) {}
  // Never return below MIN: on a narrow viewport the reserve can exceed the
  // whole width, and a max under the min would inverse the clamp.
  return Math.max(AGENT_FEEDS_MIN, vw - reserved);
}

// Pure: clamp any candidate width to [MIN, max]; non-numeric / non-positive
// (null storage, garbage, 0) falls back to the default. 0 is never a valid
// width here — "closed" is a class-driven state, not a zero width.
// `max` is injected (not read from the DOM) so this stays pure and headlessly
// testable; callers pass agentFeedsMaxWidth().
function clampAgentFeedsWidth(w, max) {
  var hi = (typeof max === 'number' && isFinite(max) && max > 0) ? max : AGENT_FEEDS_MAX;
  if (hi < AGENT_FEEDS_MIN) hi = AGENT_FEEDS_MIN;
  w = parseInt(w, 10);
  // The default itself must respect the ceiling — on a narrow viewport the
  // ceiling can sit below DEFAULT, and returning DEFAULT would overflow it.
  if (!isFinite(w) || w <= 0) return Math.min(AGENT_FEEDS_DEFAULT, hi);
  if (w < AGENT_FEEDS_MIN) return AGENT_FEEDS_MIN;
  if (w > hi) return hi;
  return w;
}

function agentFeedsTab(tab) {
  if (tab) return tab;
  try { return typeof sidePanelTab === 'string' ? sidePanelTab : 'agents'; }
  catch (e) { return 'agents'; }
}

function agentFeedsDefaultWidth(tab, viewportWidth, max) {
  var browser = agentFeedsTab(tab) === 'browser';
  var vw = parseInt(viewportWidth, 10);
  if (!isFinite(vw) || vw <= 0) {
    try { vw = window.innerWidth || 0; } catch (e) { vw = 0; }
  }
  var fallback = browser ? AGENT_FEEDS_MAX : AGENT_FEEDS_DEFAULT;
  var target = vw > 0 ? Math.round(vw * (browser ? AGENT_FEEDS_BROWSER_RATIO : AGENT_FEEDS_DEFAULT_RATIO)) : fallback;
  return clampAgentFeedsWidth(target, max);
}

function agentFeedsWidthKey(tab) {
  return agentFeedsTab(tab) === 'browser' ? AGENT_FEEDS_BROWSER_WIDTH_KEY : AGENT_FEEDS_WIDTH_KEY;
}

// The persisted open width (falls back to the tab's responsive default when
// unset/invalid). Clamped against the CURRENT viewport, so a width dragged wide
// on a big monitor comes back sane on a smaller window instead of burying chat.
function getAgentFeedsWidth(tab) {
  tab = agentFeedsTab(tab);
  var raw = null;
  try { raw = localStorage.getItem(agentFeedsWidthKey(tab)); } catch (e) {}
  var max = agentFeedsMaxWidth();
  if (raw === null || raw === '' || !isFinite(parseInt(raw, 10)) || parseInt(raw, 10) <= 0) {
    return agentFeedsDefaultWidth(tab, 0, max);
  }
  return clampAgentFeedsWidth(raw, max);
}

// Mobile = the fixed-overlay breakpoint in app.css (@media max-width:768px).
// AGENT_FEEDS_MOBILE mirrors the overlay width in that block (:1036) — it's
// only the transient slide-in animation target on mobile; the resting width is
// handed back to CSS (toggleAgentFeeds clears the inline width on mobile
// onDone, so the :1036 300px rule drives). The persisted desktop width is NEVER
// pinned on mobile: it can be up to AGENT_FEEDS_MAX (720) via cross-device
// shared same-origin localStorage (desktop drag → open on a phone over the
// broker), and a pinned 720 would cover the whole phone screen with no way back
// — the resize handle is display:none on mobile, so there's no drag to reset it.
var AGENT_FEEDS_MOBILE = 300;
function agentFeedsIsMobile() {
  try { return !!(window.matchMedia && window.matchMedia('(max-width:768px)').matches); }
  catch (e) { return false; }
}

function _applyAgentFeedsWidth(panel, w) {
  panel.style.width = w + 'px';
  panel.style.minWidth = w + 'px';
}

function applyAgentFeedsTabWidth(tab) {
  if (agentFeedsIsMobile()) return;
  var panel = document.getElementById('agent-feeds');
  if (!panel || panel.classList.contains('collapsed')) return;
  _applyAgentFeedsWidth(panel, getAgentFeedsWidth(tab));
}

function _initAgentFeedsResize() {
  var panel = document.getElementById('agent-feeds');
  if (!panel) return;
  var handle = panel.querySelector('.agent-feeds-resize-handle');
  if (!handle) return;

  handle.addEventListener('pointerdown', function(e) {
    // Only resizable while open. Collapsed == closed (width 0) is a separate
    // state owned by the toggle; never resize into/out of it.
    if (panel.classList.contains('collapsed')) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('agent-feeds-resizing');
    panel.style.transition = 'none';

    var startX = e.clientX;
    var startW = panel.getBoundingClientRect().width;

    function onMove(ev) {
      // Handle sits on the panel's inner edge: LEFT when the panel is right-
      // anchored (default) → dragging left grows it (subtract dx); RIGHT when
      // flipped to the left dock → dragging right grows it (add dx).
      var dx = ev.clientX - startX;
      var flipped = document.body.classList.contains('sidebar-right');
      // Re-read the ceiling each move: collapsing the nav sidebar mid-drag
      // should widen the room available immediately.
      _applyAgentFeedsWidth(
        panel,
        clampAgentFeedsWidth(startW + (flipped ? dx : -dx), agentFeedsMaxWidth())
      );
    }
    function onUp() {
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
      document.body.classList.remove('agent-feeds-resizing');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      panel.style.transition = '';
      var w = parseInt(panel.style.width, 10);
      if (w > 0) { try { localStorage.setItem(agentFeedsWidthKey(), String(w)); } catch (e2) {} }
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });

  // Double-click resets to the default width and forgets the saved width.
  handle.addEventListener('dblclick', function() {
    if (panel.classList.contains('collapsed')) return;
    var tab = agentFeedsTab();
    _applyAgentFeedsWidth(panel, agentFeedsDefaultWidth(tab, 0, agentFeedsMaxWidth()));
    try { localStorage.removeItem(agentFeedsWidthKey(tab)); } catch (e) {}
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initAgentFeedsResize);
} else {
  _initAgentFeedsResize();
}
