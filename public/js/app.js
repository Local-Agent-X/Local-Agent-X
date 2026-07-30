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

// ── Update checker (runs on startup) ──
var _laxNativeUpdaterState = null;
var _laxServerUpdate = null;
var _laxNativeInstallPending = false;
function nativeUpdaterBridge() {
  const bridge = window.desktop && window.desktop.nativeUpdater;
  return bridge && typeof bridge.getState === 'function' && typeof bridge.check === 'function'
    && typeof bridge.install === 'function' && typeof bridge.onState === 'function' ? bridge : null;
}

function nativeUpdateActive(state) {
  return !!state && ['available', 'downloading', 'ready', 'error'].includes(state.phase);
}
function updateProgress(state) {
  const percent = Number(state && state.percent);
  return Number.isFinite(percent) ? ` (${Math.max(0, Math.min(100, percent)).toFixed(0)}%)` : '';
}

function nativeUpdateMarkup(state, buttonClass, fallbackHandler) {
  const version = state && state.availableVersion ? ` v${esc(state.availableVersion)}` : '';
  const reassurance = ' Your projects, settings, and conversations will be preserved.';
  if (state.phase === 'ready') {
    return `<strong>Update${version} is ready.</strong>${reassurance} <button class="${buttonClass}" onclick="nativeUpdaterInstall()"${_laxNativeInstallPending ? ' disabled' : ''}>${_laxNativeInstallPending ? 'Restarting…' : 'Restart to Update'}</button>`;
  }
  if (state.phase === 'error') {
    const message = state.error ? `: ${esc(state.error)}` : '.';
    const fallback = _laxServerUpdate && _laxServerUpdate.nativeUpdateRequired && _laxServerUpdate.nativeInstallerUrl
      ? ` <button class="${buttonClass}" onclick="${fallbackHandler}()">Download Installer</button>` : '';
    return `<strong>Update failed${message}</strong> <button class="${buttonClass}" onclick="nativeUpdaterRetry()">Retry</button>${fallback}`;
  }
  const activity = state.phase === 'available' ? 'is available and will download in the background' : `is downloading in the background${updateProgress(state)}`;
  return `<strong>Update${version} ${activity}.</strong> You can keep working.${reassurance}`;
}

function renderUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (!banner || sessionStorage.getItem('lax_update_dismissed')) return;
  const state = _laxNativeUpdaterState;
  const data = _laxServerUpdate;
  let content = '';
  if (nativeUpdateActive(state)) {
    content = nativeUpdateMarkup(state, 'update-btn', 'bannerOpenNativeInstaller');
  } else if (data && data.nativeUpdateRequired && data.nativeInstallerUrl) {
    window._laxNativeInstallerUrl = data.nativeInstallerUrl;
    const electron = data.installedElectronVersion && data.requiredElectronVersion
      ? ` Electron ${esc(data.installedElectronVersion)} → ${esc(data.requiredElectronVersion)}.` : '';
    const chromium = data.installedChromiumVersion && data.requiredChromiumVersion
      ? ` Chromium ${esc(data.installedChromiumVersion)} → ${esc(data.requiredChromiumVersion)}.` : '';
    content = `<strong>Browser engine app update required.</strong>${electron}${chromium} Your projects, settings, and conversations will be preserved. <button class="update-btn" onclick="bannerOpenNativeInstaller()">Download Update</button>`;
  } else if (data && data.updateAvailable) {
    content = `Update available: v${esc(data.remoteVersion)}${data.remoteCommit ? ' (' + esc(data.remoteCommit) + ')' : ''}${data.releaseNotes ? ' — ' + esc(data.releaseNotes) : ''} <button class="update-btn" onclick="bannerApplyUpdate()">Update Now</button> <button class="update-btn" onclick="window.open('https://github.com/Local-Agent-X/Local-Agent-X','_blank')" style="opacity:.75">View on GitHub</button>`;
  }
  if (!content) return;
  banner.style.display = '';
  banner.className = 'visible';
  banner.innerHTML = `<span class="update-msg">${content}</span><button class="update-dismiss" onclick="dismissUpdate()" title="Dismiss">&times;</button>`;
}

function renderSettingsUpdate(data) {
  if (data) _laxServerUpdate = data;
  const status = document.getElementById('settings-update-status');
  if (!status) return;
  const state = _laxNativeUpdaterState;
  const server = _laxServerUpdate;
  if (nativeUpdateActive(state)) {
    status.style.color = state.phase === 'error' ? 'var(--error, red)' : 'var(--accent)';
    status.innerHTML = nativeUpdateMarkup(state, 'action-btn primary', 'settingsOpenNativeInstaller');
  } else if (state && state.phase === 'checking') {
    status.style.color = 'var(--muted)';
    status.textContent = 'Checking for updates…';
  } else if (server && server.nativeUpdateRequired && server.nativeInstallerUrl) {
    window._laxSettingsNativeInstallerUrl = server.nativeInstallerUrl;
    status.style.color = 'var(--accent)';
    const electron = server.installedElectronVersion && server.requiredElectronVersion
      ? ` Electron ${esc(server.installedElectronVersion)} → ${esc(server.requiredElectronVersion)}.` : '';
    const chromium = server.installedChromiumVersion && server.requiredChromiumVersion
      ? ` Chromium ${esc(server.installedChromiumVersion)} → ${esc(server.requiredChromiumVersion)}.` : '';
    status.innerHTML = `<strong>Browser engine app update required.</strong>${electron}${chromium} Your projects, settings, and conversations will be preserved. <button class="action-btn primary" onclick="settingsOpenNativeInstaller()">Download Update</button>`;
  } else if (server && server.error) {
    status.style.color = 'var(--error, red)';
    status.textContent = 'Could not check for updates: ' + String(server.error);
  } else if (server && server.updateAvailable) {
    status.style.color = 'var(--accent)';
    const summary = `Update available: v${esc(server.remoteVersion)}${server.remoteCommit ? ' (' + esc(server.remoteCommit) + ')' : ''}${server.releaseNotes ? ' — ' + esc(server.releaseNotes) : ''}`;
    status.innerHTML = `${summary} <button class="action-btn primary" onclick="settingsApplyUpdate()">Update Now</button> <a href="https://github.com/Local-Agent-X/Local-Agent-X" target="_blank">View on GitHub</a>`;
  } else if (server) {
    status.style.color = 'var(--accent)';
    const runtimes = [server.installedElectronVersion ? `Electron ${server.installedElectronVersion}` : '', server.installedChromiumVersion ? `Chromium ${server.installedChromiumVersion}` : ''].filter(Boolean);
    const warning = server.nativeRuntimeCheckError ? ` Browser engine update check warning: ${server.nativeRuntimeCheckError}` : '';
    status.textContent = `You are up to date! (v${server.localVersion || (state && state.currentVersion) || '0.1.0'})${runtimes.length ? ` — ${runtimes.join(', ')}` : ''}${warning}`;
  }
}

async function laxCheckUpdates(manual) {
  const bridge = nativeUpdaterBridge();
  const tasks = [apiFetch('/api/updates/check').then(r => r.json()).then(data => {
    _laxServerUpdate = data;
    if (data.nativeInstallerUrl) {
      window._laxNativeInstallerUrl = data.nativeInstallerUrl;
      window._laxSettingsNativeInstallerUrl = data.nativeInstallerUrl;
    }
  })];
  if (manual && bridge) tasks.push(bridge.check().then(state => { if (state) _laxNativeUpdaterState = state; }));
  const results = await Promise.allSettled(tasks);
  if (manual && results.every(result => result.status === 'rejected')) {
    const status = document.getElementById('settings-update-status');
    if (status) { status.style.color = 'var(--error, red)'; status.textContent = 'Could not check for updates.'; }
    return;
  }
  renderUpdateBanner();
  renderSettingsUpdate();
}

async function nativeUpdaterRetry() {
  const bridge = nativeUpdaterBridge();
  if (!bridge) return;
  try { _laxNativeUpdaterState = await bridge.check(); } catch (e) {
    _laxNativeUpdaterState = { phase: 'error', error: e && e.message ? e.message : String(e) };
  }
  renderUpdateBanner();
  renderSettingsUpdate();
}

async function nativeUpdaterInstall() {
  const bridge = nativeUpdaterBridge();
  if (!bridge || _laxNativeInstallPending) return;
  _laxNativeInstallPending = true;
  renderUpdateBanner();
  renderSettingsUpdate();
  try {
    const accepted = await bridge.install();
    if (!accepted) throw new Error('The update could not be started.');
  } catch (e) {
    _laxNativeUpdaterState = { ...(_laxNativeUpdaterState || {}), phase: 'error', error: e && e.message ? e.message : String(e) };
    _laxNativeInstallPending = false;
    renderUpdateBanner();
    renderSettingsUpdate();
  }
}

(function initializeUpdateUI() {
  const bridge = nativeUpdaterBridge();
  if (bridge && !window._laxNativeUpdaterSubscribed) {
    window._laxNativeUpdaterSubscribed = true;
    bridge.onState(state => {
      if (!state) return;
      _laxNativeUpdaterState = state;
      renderUpdateBanner();
      renderSettingsUpdate();
    });
    bridge.getState().then(state => {
      if (state) _laxNativeUpdaterState = state;
      renderUpdateBanner();
      renderSettingsUpdate();
    }, error => {
      _laxNativeUpdaterState = { phase: 'error', error: error && error.message ? error.message : String(error) };
      renderUpdateBanner();
      renderSettingsUpdate();
    });
  }
  if (!sessionStorage.getItem('lax_update_dismissed')) void laxCheckUpdates(false);
})();

function bannerOpenNativeInstaller() {
  const rawUrl = window._laxNativeInstallerUrl;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Unsupported installer URL');
    window.open(url.href, '_blank', 'noopener');
  } catch (e) {
    const banner = document.getElementById('update-banner');
    if (banner) {
      const message = e && e.message ? e.message : String(e);
      banner.innerHTML = `<span class="update-msg" style="color:var(--error,#f88)">Could not open the installer: ${esc(message)}</span> <button class="update-dismiss" onclick="dismissUpdate()" title="Dismiss">&times;</button>`;
    }
  }
}

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

function dismissUpdate() {
  const banner = document.getElementById('update-banner');
  if (banner) { banner.style.display = 'none'; banner.className = ''; }
  sessionStorage.setItem('lax_update_dismissed', '1');
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
  // One apply per UI at a time. The server also refuses overlapping applies
  // machine-wide — this just avoids sending the doomed second request when
  // an impatient click lands during the multi-minute validation.
  if (window._laxUpdateInFlight) return;
  if (!confirm('Pull the latest version from GitHub? You will be asked to relaunch the app afterward to finish installing.')) return;
  window._laxUpdateInFlight = true;
  banner.innerHTML = `<span class="update-msg">Updating — downloading and validating in a sandbox. This can take several minutes (longer when dependencies changed). Leave the app open…</span>`;
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
  } finally {
    window._laxUpdateInFlight = false;
  }
}
