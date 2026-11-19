// ── Update banner ──
// The startup update check and its two surfaces (the banner and Settings → Updates),
// for both kinds of update: LAX's code (/api/updates/*) and the desktop shell
// (the native updater bridge). The progress bar it shows is update-progress-bar.js.

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
    const both = codeUpdateWaiting() ? ' The latest code update installs first, so one restart finishes both.' : '';
    return `<strong>Update${version} is ready.</strong>${both}${reassurance} <button class="${buttonClass}" onclick="nativeUpdaterInstall()"${_laxNativeInstallPending ? ' disabled' : ''}>${_laxNativeInstallPending ? 'Restarting…' : 'Restart to Update'}</button>`;
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
    content = `${updateSummary(data)} <button class="update-btn" onclick="bannerApplyUpdate()">${data.ready ? 'Install Now' : 'Update Now'}</button> <button class="update-btn" onclick="window.open('https://github.com/Local-Agent-X/Local-Agent-X','_blank')" style="opacity:.75">View on GitHub</button>`;
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
    status.innerHTML = `${updateSummary(server)} <button class="action-btn primary" onclick="settingsApplyUpdate()">${server.ready ? 'Install Now' : 'Update Now'}</button> <a href="https://github.com/Local-Agent-X/Local-Agent-X" target="_blank">View on GitHub</a>`;
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

function codeUpdateWaiting() {
  return !!(_laxServerUpdate && _laxServerUpdate.updateAvailable && !_laxServerUpdate.error);
}

// One restart for both kinds of update. The desktop shell installer relaunches
// LAX, but the shell carries no LAX code, so a code update still waiting would
// need a second restart right after it. It lands first, with the usual progress
// bar, and the installer's relaunch starts the new code. A code update that
// does not install never holds the shell back: it is offered again after.
async function applyCodeUpdateBeforeRestart() {
  if (!codeUpdateWaiting() || window._laxUpdateInFlight) return;
  window._laxUpdateInFlight = true;
  const banner = document.getElementById('update-banner');
  const targets = [banner && banner.querySelector('.update-msg'), document.getElementById('settings-update-status')].filter(Boolean);
  const watch = typeof window.watchUpdateProgress === 'function' ? window.watchUpdateProgress : null;
  const stops = watch ? targets.map(el => watch(el)) : [];
  try {
    const res = await apiFetch('/api/updates/apply', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) _laxServerUpdate = { ..._laxServerUpdate, updateAvailable: false, ready: false };
    else console.warn('[update] the code update did not install; it is offered again after the restart:', data.error || res.status);
  } catch (e) {
    console.warn('[update] the code update did not install; it is offered again after the restart:', e && e.message ? e.message : e);
  } finally {
    stops.forEach(stop => stop());
    window._laxUpdateInFlight = false;
  }
}

/** After a code update: restart through the shell installer when one is ready too, else a plain relaunch. */
function laxRelaunchToFinish() {
  if (nativeUpdaterBridge() && _laxNativeUpdaterState && _laxNativeUpdaterState.phase === 'ready') return nativeUpdaterInstall();
  return window.desktop.relaunchApp();
}

async function nativeUpdaterInstall() {
  const bridge = nativeUpdaterBridge();
  if (!bridge || _laxNativeInstallPending) return;
  _laxNativeInstallPending = true;
  renderUpdateBanner();
  renderSettingsUpdate();
  try {
    await applyCodeUpdateBeforeRestart();
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
  if (!confirm(updateConfirmText(_laxServerUpdate))) return;
  window._laxUpdateInFlight = true;
  banner.innerHTML = `<span class="update-msg"></span>`;
  const stopProgress = watchUpdateProgress(banner.querySelector('.update-msg'));
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
      banner.innerHTML = `<span class="update-msg">${pulled} Relaunch to finish installing.</span> <button class="update-btn" onclick="laxRelaunchToFinish()">Quit &amp; Relaunch</button> <button class="update-dismiss" onclick="dismissUpdate()" title="Dismiss">&times;</button>`;
    } else {
      banner.innerHTML = `<span class="update-msg">${pulled} <strong>Quit and relaunch the app to finish installing.</strong></span> <button class="update-dismiss" onclick="dismissUpdate()" title="Dismiss">&times;</button>`;
    }
  } catch (e) {
    banner.innerHTML = `<span class="update-msg" style="color:var(--error,#f88)">Update failed: ${esc(e && e.message ? e.message : String(e))}</span> <button class="update-dismiss" onclick="dismissUpdate()" title="Dismiss">&times;</button>`;
  } finally {
    stopProgress();
    window._laxUpdateInFlight = false;
  }
}
