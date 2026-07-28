// ── Chat: composer control folding (⋯ overflow popover) ──
//
// #composer-bar is one nowrap flex row whose right cluster (attach, the voice
// trio, stop/send) is all flex-shrink:0, so #composer-chips absorbed the entire
// squeeze and got guillotined mid-word by its own overflow:hidden. This module
// is the half of the fix CSS cannot do.
//
// The trigger is the CHAT COLUMN's width, measured off #input-area — NOT the
// viewport. The composer loses width to the right rail (browser / agents panel
// drag) just as often as to a small window, and a @media query is blind to
// that. app.css keys its composer rules to `@container chat` for the same
// reason; the thresholds here mirror that container's breakpoints exactly
// (#input-area is a block child of #chat-main, so their widths are equal).
//
// Two invariants keep this honest:
//   1. Controls are MOVED, never cloned. #dictate-btn / #mic-btn carry live
//      state classes (.dictating / .listening) and are re-selected by id from
//      chat-dictate.js and chat-voice-mic.js — a duplicate would desync.
//   2. The voice trio never moves at all: it already lives inside
//      #composer-overflow-items, and CSS alone reshapes that span from an
//      inline bar segment into the popover. Only the Plan chip and project
//      picker are real moves, because their home is #composer-chips.
//
// #composer-chips is rebuilt wholesale by updateStatusBar (chat-status-bar.js)
// on every tick, which resurrects the Plan chip and project picker back in the
// row — so updateStatusBar calls syncComposerOverflow() after each render.

// Fold thresholds in px of #input-area width. Keep in step with the
// `@container chat` breakpoints in app.css: CSS shrinks the chips at every
// step, these two steps remove controls from the row outright.
var COMPOSER_FOLD_VOICE = 460;
var COMPOSER_FOLD_CHIPS = 380;

// Controls whose home container differs from the popover, so folding them is a
// real DOM move: [id, home parent id, insert-before anchor id]. Listed in
// restore order, and folded in the same order, so the popover always reads
// dictate · mic · voice · Plan · project.
var COMPOSER_FOLD_MOVES = [
  ['plan-mode-chip', 'composer-chips', 'model-chip'],
  ['project-quick-select', 'composer-chips', 'model-chip'],
];

// Pure: which control ids belong in the ⋯ popover at this composer width.
// No DOM access — the contract test evaluates this headlessly.
// Width 0 means the chat page is display:none and every rect measures 0;
// folding everything away behind a ⋯ nobody can see would be worse than
// leaving the row alone, so an unmeasurable width folds nothing.
function laxComposerFoldPlan(width) {
  var w = parseInt(width, 10);
  if (!isFinite(w) || w <= 0) return [];
  var out = [];
  if (w <= COMPOSER_FOLD_VOICE) out.push('dictate-btn', 'mic-btn', 'voice-cfg-btn');
  if (w <= COMPOSER_FOLD_CHIPS) out.push('plan-mode-chip', 'project-quick-select');
  return out;
}

function closeComposerOverflow() {
  var wrap = document.getElementById('composer-overflow');
  if (!wrap) return;
  wrap.classList.remove('open');
  var btn = document.getElementById('composer-overflow-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleComposerOverflow(ev) {
  if (ev) ev.stopPropagation();
  var wrap = document.getElementById('composer-overflow');
  if (!wrap) return;
  var open = !wrap.classList.contains('open');
  // The model cascade and the voice popover anchor to the same corner of the
  // composer; two open at once would overlap.
  if (open) {
    try { if (typeof closeModelMenu === 'function') closeModelMenu(); } catch (e) {}
    try { if (typeof closeVoicePop === 'function') closeVoicePop(); } catch (e) {}
  }
  wrap.classList.toggle('open', open);
  var btn = document.getElementById('composer-overflow-btn');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// Resolve the ONE live node for a foldable control, dropping stale twins.
//
// updateStatusBar rebuilds #composer-chips wholesale, so while a control is
// folded its node gets recreated in the row on every tick while the copy that
// was already moved still sits in the popover. Both carry the same id, and the
// popover grew one dead duplicate per tick until it was a stack of them.
//
// A node freshly rendered into the home container always wins — it reflects the
// current state (the Plan chip's colour, the project picker's selection); the
// folded copy is a snapshot. With no fresh node, the last folded copy is the
// live one. Everything else is removed, which also keeps getElementById honest.
function _composerClaimControl(id, home, items) {
  var fresh = home ? home.querySelector('#' + id) : null;
  var folded = items.querySelectorAll('#' + id);
  if (fresh) {
    for (var i = 0; i < folded.length; i++) folded[i].remove();
    return fresh;
  }
  for (var j = 0; j < folded.length - 1; j++) folded[j].remove();
  return folded.length ? folded[folded.length - 1] : null;
}

// Re-entry guard: syncComposerOverflow runs from a ResizeObserver and moves DOM
// nodes. Those moves don't change #input-area's width (it's a block child that
// takes its width from #chat-main, not from its contents) so they can't feed
// back into the observer — but a guard costs nothing and makes that guarantee
// local instead of two files away.
var _composerFoldBusy = false;

function syncComposerOverflow() {
  if (_composerFoldBusy) return;
  var wrap = document.getElementById('composer-overflow');
  var items = document.getElementById('composer-overflow-items');
  var area = document.getElementById('input-area');
  if (!wrap || !items || !area) return;

  var width = 0;
  try { width = area.getBoundingClientRect().width || 0; } catch (e) {}
  if (!width) return;

  var plan = laxComposerFoldPlan(width);
  _composerFoldBusy = true;
  try {
    for (var i = 0; i < COMPOSER_FOLD_MOVES.length; i++) {
      var id = COMPOSER_FOLD_MOVES[i][0];
      var home = document.getElementById(COMPOSER_FOLD_MOVES[i][1]);
      var el = _composerClaimControl(id, home, items);
      // Absent until the first updateStatusBar render (or with no active chat).
      if (!el) continue;
      if (plan.indexOf(id) !== -1) {
        if (el.parentElement !== items) items.appendChild(el);
        continue;
      }
      if (el.parentElement !== items || !home) continue;
      var anchor = document.getElementById(COMPOSER_FOLD_MOVES[i][2]);
      if (anchor && anchor.parentElement === home) home.insertBefore(el, anchor);
      else home.appendChild(el);
    }
    wrap.classList.toggle('has-folded', plan.length > 0);
    // .composer-pop is the shared popover box (app.css) — the model cascade and
    // the voice popover carry it in the markup; this one only wears it while
    // folded, since unfolded it's an inline segment of the bar, not a popover.
    items.classList.toggle('composer-pop', plan.length > 0);
    if (!plan.length) closeComposerOverflow();
  } finally {
    _composerFoldBusy = false;
  }
}

// Guarded so the module can be evaluated headlessly (the contract test pulls
// laxComposerFoldPlan out of the raw source with new Function).
if (typeof document !== 'undefined') {
  var _initComposerOverflow = function () {
    var area = document.getElementById('input-area');
    if (!area) return;
    syncComposerOverflow();
    if (typeof ResizeObserver === 'function') {
      // Watches the live chat-column width, so dragging the right rail folds
      // the row mid-drag exactly the way resizing the window does.
      new ResizeObserver(function () { syncComposerOverflow(); }).observe(area);
    } else {
      window.addEventListener('resize', syncComposerOverflow);
    }
    // No dismiss listeners here on purpose: outside-click and Escape for EVERY
    // composer popover live in chat-composer-menus.js, which calls
    // closeComposerOverflow through _closeComposerOverflowIfPresent. A second
    // pair of document listeners is how the three popovers would drift into
    // three slightly different dismiss behaviours.
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initComposerOverflow);
  } else {
    _initComposerOverflow();
  }
}
