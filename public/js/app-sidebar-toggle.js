// Desktop sidebar collapse toggle (spring-animated)
function toggleSidebarCollapse() {
  const sidebar = document.getElementById('sidebar');
  const expandBtn = document.getElementById('sidebar-expand-btn');
  if (!sidebar) return;
  const collapsed = !sidebar.classList.contains('collapsed');
  // Disable CSS transition — spring handles it
  sidebar.style.transition = 'none';
  if (collapsed) {
    sidebar.classList.add('collapsed');
    Spring.animate(sidebar, 'width', 0, { from: sidebar.offsetWidth, preset: 'stiff', unit: 'px', onUpdate: v => { sidebar.style.minWidth = v + 'px'; }, onDone: () => { sidebar.style.transition = ''; } });
    if (expandBtn) expandBtn.style.display = 'block';
  } else {
    sidebar.classList.remove('collapsed');
    sidebar.style.overflow = 'hidden';
    const expandedW = (typeof window.__sidebarExpandedWidth === 'function') ? window.__sidebarExpandedWidth() : 256;
    Spring.animate(sidebar, 'width', expandedW, { from: 0, preset: 'stiff', unit: 'px', onUpdate: v => { sidebar.style.minWidth = v + 'px'; }, onDone: () => { sidebar.style.overflow = ''; sidebar.style.transition = ''; } });
    if (expandBtn) expandBtn.style.display = 'none';
  }
  localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '');
}

// Restore sidebar state on load
(function() {
  if (localStorage.getItem('sidebar-collapsed') === '1') {
    const sidebar = document.getElementById('sidebar');
    const expandBtn = document.getElementById('sidebar-expand-btn');
    if (sidebar) sidebar.classList.add('collapsed');
    if (expandBtn) expandBtn.style.display = 'block';
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
      if (dragging) applyWidth(startW + (e.clientX - startX), false);
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
