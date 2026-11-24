// App shell: routing, dynamic pins, update banner, and boot.
const ROUTES = ['chat', 'missions', 'apps', 'agents'];
var _sidebarPins = []; // Dynamic pinned pages (var for cross-script WebSocket access)
function navigate(route) {
  const isPin = route.startsWith('pin:');
  if (!isPin && !ROUTES.includes(route)) route = 'chat';
  const prevRoute = currentRoute();
  location.hash = '#' + route;

  // IDE fullscreen hides the sidebar. Keep the class in sync with whether
  // the IDE is actually visible on the apps page — otherwise nav-away
  // leaves the sidebar hidden on chat/settings, and nav-back leaves
  // the IDE up with the sidebar showing on top of it. The IDE container
  // is the source of truth (style.display === 'flex' means the user is
  // in IDE mode); the class just mirrors that whenever the apps route is
  // (or isn't) the active one. localStorage is NOT touched here — that's
  // exitIdeView's job, so cross-route round-trips don't lose the session.
  const ideEl = document.getElementById('apps-ide');
  const ideOpen = ideEl && ideEl.style.display === 'flex';
  if (route === 'apps' && ideOpen) {
    document.body.classList.add('ide-fullscreen');
  } else if (route !== 'apps') {
    document.body.classList.remove('ide-fullscreen');
  }

  // Hide all built-in pages
  ROUTES.forEach(r => {
    const page = document.getElementById('page-' + r);
    if (!page) return;
    if (!isPin && r === route) {
      page.classList.add('active');
      if (r !== prevRoute && typeof Spring !== 'undefined') {
        page.style.opacity = '0';
        page.style.transform = 'translateY(12px)';
        Spring.animate(page, 'opacity', 1, { from: 0, preset: 'stiff' });
        Spring.animate(page, 'y', 0, { from: 12, preset: 'stiff', unit: 'px', onDone: () => { page.style.transform = ''; } });
      }
    } else {
      if (typeof Spring !== 'undefined') Spring.stop(page);
      page.style.opacity = '';
      page.style.transform = '';
      page.style.display = '';
      page.classList.remove('active');
    }
  });

  // Handle pinned page via iframe. A pin is agent-built content: agentFrameTarget
  // (shared-md.js) loads it off this origin, cache-busted on every click so an
  // agent's edits show, and says whether the frame may keep that origin.
  const pinPage = document.getElementById('page-pin');
  const pinIframe = document.getElementById('pin-iframe');
  if (isPin && pinPage && pinIframe) {
    const pinName = route.slice(4); // strip "pin:"
    const pin = _sidebarPins.find(p => p.name === pinName);
    if (pin) {
      agentFrameTargetFor(pin.url).then((target) => {
        if (!target) return;
        pinIframe.sandbox.toggle('allow-same-origin', target.ownOrigin);
        pinIframe.src = target.src;
      });
      pinPage.classList.add('active');
    }
  } else if (pinPage) {
    pinPage.classList.remove('active');
  }

  // Highlight active util button
  document.querySelectorAll('.util-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.route === route);
  });
  // Highlight active pinned item
  document.querySelectorAll('.pinned-item').forEach(b => {
    b.classList.toggle('active', b.dataset.route === route);
  });
  // Init page if it has an init function
  if (!isPin && window['init_' + route]) window['init_' + route]();
}

function currentRoute() {
  const hash = location.hash.slice(1) || 'chat';
  if (hash.startsWith('pin:')) return hash;
  return ROUTES.includes(hash) ? hash : 'chat';
}

// ── Sidebar Pins (dynamic, agent-controllable) ──
function loadSidebarPins() {
  fetch('/api/sidebar/pins', { headers: { Authorization: 'Bearer ' + AUTH_TOKEN } })
    .then(r => r.ok ? r.json() : { pins: [] })
    .then(data => {
      _sidebarPins = data.pins || [];
      renderSidebarPins();
    }).catch(() => {});
}

function renderSidebarPins() {
  const section = document.getElementById('pinned-section');
  const list = document.getElementById('pinned-list');
  if (!section || !list) return;
  if (_sidebarPins.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  list.innerHTML = _sidebarPins.map(p =>
    '<div class="pinned-item" data-route="pin:' + esc(p.name) + '" onclick="navigate(\'pin:' + esc(p.name) + '\')" title="' + esc(p.name) + '">' +
      '<span class="pinned-icon">' + (p.icon || '📌') + '</span>' +
      '<span class="pinned-name">' + esc(p.name) + '</span>' +
    '</div>'
  ).join('');
}

// Load pins on startup and listen for WebSocket updates
document.addEventListener('DOMContentLoaded', loadSidebarPins);

// ── Boot ──
// Sync from server on page load (after initial render from cache)
setTimeout(() => syncChatsFromServer(), 500);
setTimeout(() => { migrateLegacyLocalStorageProjects().then(() => syncProjectsFromServer()); }, 600);

renderSidebar();
checkAuth();
window.addEventListener('hashchange', () => navigate(currentRoute()));
// Defer initial navigate to DOMContentLoaded so per-route init functions
// (init_chat, etc.) defined in later <script> tags exist by the time we
// dispatch. Running at top-level here would race chat.js loading and skip
// initStatusBar — leaving the provider/model dropdowns blank until the
// user manually triggers a re-navigate (e.g. clicking "New Chat").
// After the first navigate builds the JS-injected regions (the composer control
// row + sidebar lists) — and after the preload's earlier DOMContentLoaded
// listener has set the platform-win class — flip body.app-ready. The whole shell
// is held at opacity:0 by the boot reveal gate in app.css until then, so it fades
// in ONCE, fully-built and correctly laid out, instead of assembling piecemeal
// (fallback layout → chrome → lists). Same hide-until-built pattern as
// sidebar-controls-ready, promoted from three regions to the entire shell.
function bootNavigate() {
  navigate(currentRoute());
  requestAnimationFrame(() => document.body.classList.add('app-ready'));
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootNavigate);
} else {
  bootNavigate();
}
// Safety net: the gate hides the ENTIRE shell until app-ready, so if bootNavigate
// throws before flipping it the app would be blank forever. Force the reveal on a
// timer regardless. Idempotent with the rAF above. Armed from DOMContentLoaded
// (not script eval) so a slow first parse can't burn the budget before
// bootNavigate even gets a chance to run — firing mid-assembly is exactly the
// piecemeal render the gate exists to prevent.
const _armRevealSafetyNet = () => setTimeout(() => document.body.classList.add('app-ready'), 2000);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _armRevealSafetyNet);
} else {
  _armRevealSafetyNet();
}

// Auto-refresh sidebar every 30s to pick up new WhatsApp sessions
setInterval(() => {
  syncChatsFromServer().then(() => renderChatList()).catch(() => {});
}, 30000);


window.showHealthBanner = function (message) {
  const banner = document.getElementById('health-banner');
  if (!banner) return;
  banner.style.display = 'flex';
  banner.innerHTML = `
    <span style="flex:1">⚠ ${esc(message)}</span>
    <button onclick="hideHealthBanner()" title="Dismiss" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1rem;padding:2px 6px">&times;</button>
  `;
};
window.hideHealthBanner = function () {
  const banner = document.getElementById('health-banner');
  if (banner) banner.style.display = 'none';
};
