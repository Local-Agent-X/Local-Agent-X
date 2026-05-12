// ── Settings: Agent Sync ──
//
// Background-sync config (pull/push to a remote, push interval, etc.)
// + manual sync triggers (syncNow / forcePull / forcePush) + status pill.

// ── Agent Sync ──

async function checkSyncStatus() {
  try {
    const d = await apiJson('/api/sync/status');
    const el = document.getElementById('sync-status');
    if (!el) return;
    if (d.enabled) {
      el.className = 'status-badge ok';
      const ago = d.lastSync ? Math.round((Date.now() - d.lastSync) / 1000) : 0;
      el.innerHTML = `<span class="status-dot"></span> ${d.isSyncing ? 'Syncing...' : ago ? `Last synced ${ago}s ago` : 'Enabled — not yet synced'}`;
      const tog = document.getElementById('tog-sync'); if (tog) tog.classList.add('on');
    } else {
      el.className = 'status-badge warn';
      el.innerHTML = '<span class="status-dot"></span> Not configured';
    }
    // Populate form fields from server config
    if (d.repoUrl) {
      const repoEl = document.getElementById('cfg-sync-repo');
      if (repoEl && !repoEl.value) repoEl.value = d.repoUrl;
    }
  } catch {}
}

async function loadSyncConfig() {
  try {
    const d = await apiJson('/api/sync/status');
    const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
    set('cfg-sync-repo', d.repoUrl);
    set('cfg-sync-interval', d.interval);
    if (d.enabled) { const el = document.getElementById('tog-sync'); if (el) el.classList.add('on'); }
    if (d.autoDownload) { const el = document.getElementById('tog-sync-autodownload'); if (el) el.classList.add('on'); }
    if (d.syncSessions) { const el = document.getElementById('tog-sync-sessions'); if (el) el.classList.add('on'); }
    if (d.syncWorkspace) { const el = document.getElementById('tog-sync-workspace'); if (el) el.classList.add('on'); }
    // syncMissions / syncProtocols default to true server-side. Reflect that
    // in the UI when the API returns the value as truthy OR undefined (older
    // servers that don't return these fields).
    const missionsOn = d.syncMissions !== false;
    const protocolsOn = d.syncProtocols !== false;
    if (missionsOn) { const el = document.getElementById('tog-sync-missions'); if (el) el.classList.add('on'); }
    if (protocolsOn) { const el = document.getElementById('tog-sync-protocols'); if (el) el.classList.add('on'); }
  } catch {}
}

async function saveSyncConfig() {
  const repo = document.getElementById('cfg-sync-repo')?.value?.trim();
  const token = document.getElementById('cfg-sync-token')?.value?.trim();
  const interval = document.getElementById('cfg-sync-interval')?.value;
  const enabled = document.getElementById('tog-sync')?.classList.contains('on');
  const autoDownload = document.getElementById('tog-sync-autodownload')?.classList.contains('on');
  const syncSessions = document.getElementById('tog-sync-sessions')?.classList.contains('on');
  const syncWorkspace = document.getElementById('tog-sync-workspace')?.classList.contains('on');
  const syncMissions = document.getElementById('tog-sync-missions')?.classList.contains('on');
  const syncProtocols = document.getElementById('tog-sync-protocols')?.classList.contains('on');

  // Save token to secrets vault if provided
  if (token) {
    await apiPost('/api/secrets', { name: 'GITHUB_SYNC_TOKEN', value: token, service: 'GitHub Sync' });
    document.getElementById('cfg-sync-token').value = ''; // Clear from UI
  }

  await apiPost('/api/sync/configure', { enabled, repoUrl: repo, interval, autoDownload, syncSessions, syncWorkspace, syncMissions, syncProtocols });
  checkSyncStatus();
}

function syncMsg(d) { return d.message || d.error || d.reason || JSON.stringify(d); }

async function syncNow() {
  const el = document.getElementById('sync-result');
  if (el) el.textContent = 'Syncing...';
  await saveSyncConfig();
  try {
    const d = await apiPost('/api/sync/push', {});
    if (el) el.textContent = d.success ? `Done: ${syncMsg(d)}` : `Error: ${syncMsg(d)}`;
  } catch (e) { if (el) el.textContent = 'Sync failed: ' + e.message; }
  setTimeout(checkSyncStatus, 1000);
}

async function forcePull() {
  const el = document.getElementById('sync-result');
  if (el) el.textContent = 'Pulling...';
  await saveSyncConfig();
  try {
    const d = await apiPost('/api/sync/pull', {});
    if (el) el.textContent = d.success ? `Done: ${syncMsg(d)}` : `Error: ${syncMsg(d)}`;
  } catch (e) { if (el) el.textContent = 'Pull failed: ' + e.message; }
}

async function forcePush() {
  const el = document.getElementById('sync-result');
  if (el) el.textContent = 'Pushing...';
  await saveSyncConfig();
  try {
    const d = await apiPost('/api/sync/push', {});
    if (el) el.textContent = d.success ? `Done: ${syncMsg(d)}` : `Error: ${syncMsg(d)}`;
  } catch (e) { if (el) el.textContent = 'Push failed: ' + e.message; }
}

