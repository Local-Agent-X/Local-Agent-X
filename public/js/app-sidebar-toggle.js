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
    Spring.animate(sidebar, 'width', 0, { from: 280, preset: 'stiff', unit: 'px', onUpdate: v => { sidebar.style.minWidth = v + 'px'; }, onDone: () => { sidebar.style.transition = ''; } });
    if (expandBtn) expandBtn.style.display = 'block';
  } else {
    sidebar.classList.remove('collapsed');
    sidebar.style.overflow = 'hidden';
    Spring.animate(sidebar, 'width', 280, { from: 0, preset: 'stiff', unit: 'px', onUpdate: v => { sidebar.style.minWidth = v + 'px'; }, onDone: () => { sidebar.style.overflow = ''; sidebar.style.transition = ''; } });
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

// Keyboard navigation for sidebar (feature 100)
document.addEventListener('keydown', (e) => {
  // Alt+1-4 for sidebar navigation
  if (e.altKey && e.key >= '1' && e.key <= '4') {
    e.preventDefault();
    const routes = ['chat', 'cron', 'secrets', 'settings'];
    const idx = parseInt(e.key) - 1;
    if (routes[idx]) navigate(routes[idx]);
  }
});
