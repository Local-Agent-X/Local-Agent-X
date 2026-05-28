// ── App Shell: Routing, dynamic pins, update banner, boot ──
// State + persistence: app-state.js
// Server sync + hydrate: app-sync.js
// Sidebar mutations: app-sidebar-actions.js
// Sidebar rendering: app-sidebar-render.js
// This file owns the route system, the sidebar's dynamic "pins" (agent-
// controllable iframe tabs), the update-banner, and the boot sequence.

// ── Routing ──
const ROUTES = ['chat', 'settings', 'secrets', 'protocols', 'missions', 'apps', 'agents'];
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

  // Handle pinned page via iframe.
  // Always cache-bust on click so file changes from agents/workers show up.
  // Previously: only reloaded if URL changed → clicking the same tab after
  // an edit kept showing the OLD version until the user manually refreshed
  // the whole browser. Real workflow blocker since the agent/worker just
  // edited the app the user wants to verify.
  const pinPage = document.getElementById('page-pin');
  const pinIframe = document.getElementById('pin-iframe');
  if (isPin && pinPage && pinIframe) {
    const pinName = route.slice(4); // strip "pin:"
    const pin = _sidebarPins.find(p => p.name === pinName);
    if (pin) {
      // Pass auth token + cache-bust timestamp so iframe always reloads fresh.
      const sep = pin.url.includes('?') ? '&' : '?';
      const pinUrl = pin.url + sep + 'token=' + AUTH_TOKEN + '&_t=' + Date.now();
      pinIframe.src = pinUrl;
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
  // Only show agents toggle on chat page
  var agentsBtn = document.getElementById('agents-toggle');
  if (agentsBtn) agentsBtn.style.display = (route === 'chat') ? '' : 'none';
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
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => navigate(currentRoute()));
} else {
  navigate(currentRoute());
}

// Auto-refresh sidebar every 30s to pick up new WhatsApp sessions
setInterval(() => {
  syncChatsFromServer().then(() => renderChatList()).catch(() => {});
}, 30000);

// ── Update checker (runs on startup) ──
(async function checkForUpdates() {
  // Don't annoy users — only check once per session, and respect dismissal
  if (sessionStorage.getItem('sax_update_dismissed')) return;
  try {
    const res = await apiFetch('/api/updates/check');
    const data = await res.json();
    if (data.updateAvailable) {
      const banner = document.getElementById('update-banner');
      if (!banner) return;
      banner.style.display = '';
      banner.className = 'visible';
      banner.innerHTML = `
        <span class="update-msg">Update available: v${esc(data.remoteVersion)}${data.remoteCommit ? ' (' + esc(data.remoteCommit) + ')' : ''}${data.releaseNotes ? ' — ' + esc(data.releaseNotes) : ''}</span>
        <button class="update-btn" onclick="bannerApplyUpdate()">Update Now</button>
        <button class="update-btn" onclick="window.open('https://github.com/Local-Agent-X/Local-Agent-X','_blank')" style="opacity:.75">View on GitHub</button>
        <button class="update-dismiss" onclick="dismissUpdate()" title="Dismiss">&times;</button>
      `;
    }
  } catch {}
})();

function dismissUpdate() {
  const banner = document.getElementById('update-banner');
  if (banner) { banner.style.display = 'none'; banner.className = ''; }
  sessionStorage.setItem('sax_update_dismissed', '1');
}

// Pull + relaunch flow triggered from the boot-time banner. Mirrors
// settingsApplyUpdate() in settings.js but writes status into the banner
// instead of the settings panel, so the user can update without opening
// Settings. Both paths hit the same /api/updates/apply endpoint and rely
// on the desktop wrapper's reconcile to run npm install + build on the
// next Electron boot.
async function bannerApplyUpdate() {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  if (!confirm('Pull the latest version from GitHub? You will be asked to relaunch the app afterward to finish installing.')) return;
  banner.innerHTML = `<span class="update-msg">Pulling latest from GitHub…</span>`;
  try {
    const res = await apiFetch('/api/updates/apply', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      let msg = data.error || 'Update failed.';
      if (Array.isArray(data.dirty) && data.dirty.length) {
        msg += ' (Local changes: ' + data.dirty.slice(0, 3).join(', ') + (data.dirty.length > 3 ? '…' : '') + ')';
      }
      banner.innerHTML = `<span class="update-msg" style="color:var(--error,#f88)">${esc(msg)}</span> <button class="update-dismiss" onclick="dismissUpdate()" title="Dismiss">&times;</button>`;
      return;
    }
    const pulled = `Pulled ${esc(data.fromCommit)} → ${esc(data.toCommit)}.`;
    if (window.desktop && window.desktop.relaunchApp) {
      banner.innerHTML = `<span class="update-msg">${pulled} Relaunch to finish installing.</span> <button class="update-btn" onclick="window.desktop.relaunchApp()">Quit &amp; Relaunch</button> <button class="update-dismiss" onclick="dismissUpdate()" title="Dismiss">&times;</button>`;
    } else {
      banner.innerHTML = `<span class="update-msg">${pulled} <strong>Quit and relaunch the app to finish installing.</strong></span> <button class="update-dismiss" onclick="dismissUpdate()" title="Dismiss">&times;</button>`;
    }
  } catch (e) {
    banner.innerHTML = `<span class="update-msg" style="color:var(--error,#f88)">Update failed: ${esc(e && e.message ? e.message : String(e))}</span> <button class="update-dismiss" onclick="dismissUpdate()" title="Dismiss">&times;</button>`;
  }
}
