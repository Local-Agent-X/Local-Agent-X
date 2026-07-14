// The two dockable panels and their controls bind to a physical SIDE of the
// window, not to a specific element. Two panels exist: the nav sidebar
// (#sidebar) and the right-rail agents panel (#agent-feeds). Which one sits on
// the left vs right is owned by the `sidebar-right` body class (flip). A
// collapse button in the titlebar therefore closes whatever panel is currently
// on its side — never a hardcoded element.
function isFlipped() { return document.body.classList.contains('sidebar-right'); }
// Panel on the given physical side ('left' | 'right'), accounting for flip.
// Unflipped: nav=left, agents=right. Flipped: swapped.
function panelOnSide(side) {
  const navIsLeft = !isFlipped();
  const wantNav = (side === 'left') === navIsLeft;
  return wantNav
    ? { kind: 'nav', el: document.getElementById('sidebar') }
    : { kind: 'agents', el: document.getElementById('agent-feeds') };
}

// Collapse/expand the nav #sidebar (spring-animated). Split from the side
// dispatch so flip logic and the agents panel can reuse the nav-specific
// width restore. `sidebar-collapsed` persists the nav's own state.
function toggleNavSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const collapsed = !sidebar.classList.contains('collapsed');
  // Disable CSS transition — spring handles it
  sidebar.style.transition = 'none';
  if (collapsed) {
    sidebar.classList.add('collapsed');
    Spring.animate(sidebar, 'width', 0, { from: sidebar.offsetWidth, preset: 'stiff', unit: 'px', onUpdate: v => { sidebar.style.minWidth = v + 'px'; }, onDone: () => { sidebar.style.transition = ''; } });
  } else {
    sidebar.classList.remove('collapsed');
    sidebar.style.overflow = 'hidden';
    const expandedW = (typeof window.__sidebarExpandedWidth === 'function') ? window.__sidebarExpandedWidth() : 256;
    Spring.animate(sidebar, 'width', expandedW, { from: 0, preset: 'stiff', unit: 'px', onUpdate: v => { sidebar.style.minWidth = v + 'px'; }, onDone: () => { sidebar.style.overflow = ''; sidebar.style.transition = ''; } });
  }
  localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '');
  // The nav's own toggle must repaint its button too — without this the left
  // button never picked up an open state while the agents button did, so the
  // two sides of the same top bar disagreed.
  refreshSideButtons();
}

// Toggle whichever panel sits on `side`. This is what the titlebar buttons
// call: the LEFT cluster's hide button passes 'left', the RIGHT button 'right'.
// The panel is resolved through flip state so the button always closes the bar
// physically under it.
function toggleSidePanel(side) {
  const { kind } = panelOnSide(side);
  if (kind === 'nav') toggleNavSidebar();
  else if (typeof toggleAgentFeeds === 'function') toggleAgentFeeds();
}

// Back-compat: the left hide button + any legacy caller. Left button owns the
// left side.
function toggleSidebarCollapse() { toggleSidePanel('left'); }

// Flip both panels to the opposite side. body.sidebar-right drives the nav via
// row-reverse (CSS) and the agents rail via #page-chat row-reverse (CSS); this
// JS only owns the class + persistence. Buttons refresh so each one reads
// against the panel now under it.
function flipSidebarSide() {
  const right = document.body.classList.toggle('sidebar-right');
  localStorage.setItem('sidebar-side', right ? 'right' : '');
  refreshSideButtons();
}

// Single source of truth for every top-bar panel toggle's presentation: the
// tooltip AND the `is-open` state class the accent styling hangs off of
// (app.css). Both derive from the same question — which panel is under this
// button, and is it showing — so they're answered in one place, through the
// flip-aware panelOnSide() resolver. Call after ANY change to a panel's
// collapsed state or to the flip.
function refreshSideButtons() {
  const leftBtn = document.getElementById('sidebar-hide-btn');
  // Two right-side toggles exist in the DOM (Windows titlebar + the
  // macOS/browser window-top cluster); CSS shows exactly one per platform,
  // so keep both in sync.
  const rightBtn = document.getElementById('dtb-agents-toggle');
  const macRightBtn = document.getElementById('sidebar-agents-btn');
  [['left', leftBtn], ['right', rightBtn], ['right', macRightBtn]].forEach(([side, btn]) => {
    if (!btn) return;
    const { kind, el } = panelOnSide(side);
    // Both panels read as "sidebar" in tooltips — the left nav and the right
    // agents rail are both sidebars to the user.
    const name = 'sidebar';
    // Coerce to a real boolean: a missing #sidebar would otherwise yield null
    // here and mark the button open.
    const isCollapsed = kind === 'nav'
      ? !!(el && el.classList.contains('collapsed'))
      : !document.body.classList.contains('agents-panel-open');
    btn.title = (isCollapsed ? 'Show ' : 'Hide ') + name;
    btn.classList.toggle('is-open', !isCollapsed);
  });
}
window.refreshSideButtons = refreshSideButtons;

// Restore sidebar state on load
(function() {
  if (localStorage.getItem('sidebar-collapsed') === '1') {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.add('collapsed');
  }
  if (localStorage.getItem('sidebar-side') === 'right') {
    document.body.classList.add('sidebar-right');
  }
  // Reveal the window-top controls only once the platform class (added by the
  // preload's DOMContentLoaded handler, which is registered before this script)
  // is in place — so they appear directly at the macOS/Windows position instead
  // of flashing at the browser-fallback spot first. This script's DCL listener
  // runs after the preload's, guaranteeing the platform class is already set.
  //
  // The initial refreshSideButtons() rides the SAME gate, and must: both button
  // clusters are the last elements in <body> (they have to paint after the
  // macOS drag strips to stay clickable), while this script is parsed well
  // above them. Refreshing at parse time found no buttons and silently left
  // every one of them showing the hardcoded HTML title — which claims "Hide",
  // i.e. panel-open — so a collapsed sidebar still offered to hide itself, and
  // the nav toggle never lit up on boot. Waiting for DOMContentLoaded is what
  // makes the boot state honest.
  const reveal = () => {
    refreshSideButtons();
    document.body.classList.add('sidebar-controls-ready');
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reveal, { once: true });
  } else {
    reveal();
  }
})();

// Mobile sidebar toggle (feature 95)
function toggleMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const isOpen = sidebar.classList.toggle('mobile-open');
  let backdrop = document.getElementById('sidebar-backdrop');
  if (isOpen && !backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'sidebar-backdrop';
    backdrop.onclick = () => { sidebar.classList.remove('mobile-open'); backdrop.remove(); };
    document.body.appendChild(backdrop);
  } else if (!isOpen && backdrop) {
    backdrop.remove();
  }
}

// ── Drag-to-resize sidebar ──
// A thin handle on the sidebar's right edge sets an inline width (overriding the
// CSS default), clamped and persisted to localStorage. Double-click resets.
(function() {
  const MINW = 200, MAXW = 560, DEFAULTW = 256;
  const clampW = w => Math.max(MINW, Math.min(MAXW, w));
  function storedWidth() {
    const v = parseInt(localStorage.getItem('sidebar-width'), 10);
    return (v && !isNaN(v)) ? clampW(v) : DEFAULTW;
  }
  function applyWidth(w, persist) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    w = clampW(w);
    sidebar.style.width = w + 'px';
    sidebar.style.minWidth = w + 'px';
    if (persist) localStorage.setItem('sidebar-width', String(w));
  }
  // Lets the collapse toggle re-expand to the user's chosen width.
  window.__sidebarExpandedWidth = storedWidth;

  // Restore saved width on load (collapse owns width while collapsed, so skip).
  const sb = document.getElementById('sidebar');
  if (sb && !sb.classList.contains('collapsed') && localStorage.getItem('sidebar-width')) {
    applyWidth(storedWidth(), false);
  }

  const handle = document.getElementById('sidebar-resizer');
  if (handle) {
    let startX = 0, startW = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      const sidebar = document.getElementById('sidebar');
      if (!sidebar || sidebar.classList.contains('collapsed')) return;
      dragging = true;
      startX = e.clientX;
      startW = sidebar.offsetWidth;
      sidebar.style.transition = 'none';
      document.body.classList.add('resizing-sidebar');
      try { handle.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // Dragging outward grows the sidebar on either side — invert when flipped right.
      const dx = e.clientX - startX;
      applyWidth(document.body.classList.contains('sidebar-right') ? startW - dx : startW + dx, false);
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing-sidebar');
      const sidebar = document.getElementById('sidebar');
      if (sidebar) { sidebar.style.transition = ''; localStorage.setItem('sidebar-width', String(sidebar.offsetWidth)); }
      try { handle.releasePointerCapture(e.pointerId); } catch {}
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', () => applyWidth(DEFAULTW, true));
  }
})();

// Keyboard navigation for sidebar (feature 100)
document.addEventListener('keydown', (e) => {
  // Alt+1-4 for sidebar navigation
  if (e.altKey && e.key >= '1' && e.key <= '4') {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    if (idx === 3) { if (typeof openSettings === 'function') openSettings(); return; }
    const routes = ['chat', 'agents', 'apps'];
    if (routes[idx]) navigate(routes[idx]);
  }
});
