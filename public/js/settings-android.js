// Settings: Android SDK setup card. Mirrors settings-local-runtimes.js's
// status+action shape — poll /api/android/sdk/status, trigger install via
// /api/android/sdk/install, and poll again while it's running so the button
// shows live progress for what can be a multi-minute download+install.
let androidSdkPollTimer = null;

function androidSdkStatusHtml(data) {
  if (data.ready) {
    return '<span class="status-badge ok"><span class="status-dot"></span> Installed</span>' +
      '<div style="font-size:.7rem;color:var(--muted);margin-top:4px">SDK at ' + esc(data.sdkRoot) + '</div>';
  }
  const missing = [];
  if (!data.hasAdb) missing.push('platform-tools (adb)');
  if (!data.hasEmulator) missing.push('emulator');
  if (!data.hasCmdlineTools) missing.push('command-line tools');
  return '<span class="status-badge err"><span class="status-dot"></span> Not installed</span>' +
    '<div style="font-size:.7rem;color:var(--muted);margin-top:4px">Missing: ' + esc(missing.join(', ') || 'unknown') + ' &middot; expected at ' + esc(data.sdkRoot) + '</div>';
}

async function loadAndroidSdkStatus() {
  const el = document.getElementById('android-sdk-status');
  const btn = document.getElementById('android-sdk-install-btn');
  if (!el) return;
  try {
    const data = await apiJson('/api/android/sdk/status');
    let html = androidSdkStatusHtml(data);
    if (data.install.running) {
      html += '<div style="font-size:.72rem;color:var(--muted);margin-top:6px">' + esc(data.install.lastStep || 'Installing...') + '</div>';
      if (btn) { btn.disabled = true; btn.textContent = 'Installing...'; }
      if (!androidSdkPollTimer) androidSdkPollTimer = setTimeout(() => { androidSdkPollTimer = null; loadAndroidSdkStatus(); }, 3000);
    } else {
      if (btn) { btn.disabled = false; btn.textContent = data.ready ? 'Re-run setup' : 'Set up Android SDK'; }
      if (data.install.error) html += '<div style="font-size:.72rem;color:var(--err, #c66);margin-top:6px">Last attempt failed: ' + esc(data.install.error) + '</div>';
    }
    el.innerHTML = html;
  } catch {
    el.innerHTML = '<div style="font-size:.75rem;color:var(--err, #c66)">Failed to load Android SDK status.</div>';
  }
}

async function installAndroidSdk() {
  const btn = document.getElementById('android-sdk-install-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }
  try {
    await apiPost('/api/android/sdk/install', {});
  } catch {}
  await loadAndroidSdkStatus();
}
