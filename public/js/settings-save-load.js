// ── Settings: Save / Load (server round-trip) ──
//
// saveSettings reads every \`lax_*\` localStorage key, posts to
// /api/settings, and refreshes the in-memory cache. loadSettings is the
// inverse — pulls from the server on page load and primes localStorage.
// Sits at the end of the providers section because it's the consumer of
// every other settings field on the page.

async function saveSettings() {
  const provider = document.getElementById('cfg-provider')?.value;
  const modelInput = document.getElementById('cfg-model');
  const modelSelect = document.getElementById('cfg-model-select');
  const model = provider === 'local' ? modelSelect?.value :
    (modelSelect?.value === '__custom__' || modelSelect?.style.display === 'none') ? modelInput?.value : (modelSelect?.value || modelInput?.value);
  const portVal = document.getElementById('cfg-port')?.value;
  const s = {
    provider,
    model,
    temperature: parseFloat(document.getElementById('cfg-temperature')?.value || '0.7'),
    port: portVal ? parseInt(portVal, 10) : undefined,
    imageEngine: document.getElementById('cfg-image-engine')?.value,
    sttEngine: document.getElementById('cfg-stt-engine')?.value,
    ttsEngine: document.getElementById('cfg-tts-engine')?.value,
    ttsVoice: document.getElementById('cfg-tts-voice')?.value,
    xttsVoice: document.getElementById('cfg-xtts-voice')?.value,
    voiceEngine: document.getElementById('cfg-voice-engine')?.value,
    sandbox: document.getElementById('cfg-sandbox')?.value,
  };
  localStorage.setItem('lax_settings', JSON.stringify(s));
  // Save API key to encrypted secrets store (never plain settings.json)
  const apiKeyInput = document.getElementById('cfg-api-key');
  const apiKeyStatus = document.getElementById('api-key-status');
  if (apiKeyInput && apiKeyInput.value && PROVIDER_KEY_CONFIG[provider]) {
    try {
      await apiPost('/api/secrets', { name: PROVIDER_KEY_CONFIG[provider].secretName, value: apiKeyInput.value });
      localStorage.setItem('lax_apikey_' + provider, 'saved'); // flag only, not the actual key
      if (apiKeyStatus) { apiKeyStatus.className = 'status-badge ok'; apiKeyStatus.innerHTML = '<span class="status-dot"></span> Key saved securely'; }
    } catch (e) {
      if (apiKeyStatus) { apiKeyStatus.className = 'status-badge err'; apiKeyStatus.innerHTML = '<span class="status-dot"></span> Failed to save key'; }
    }
  }
  // Save provider + model to server (no API key in settings.json)
  const currentPort = location.port || '7007';
  const maxIter = parseInt(document.getElementById('cfg-maxiter')?.value || '25', 10);
  const embProvider = document.getElementById('cfg-emb-provider')?.value || 'ollama';
  const embModel = document.getElementById('cfg-emb-model')?.value || '';
  const settingsPayload = { provider: s.provider, model: s.model, temperature: s.temperature, maxIterations: maxIter, embeddingProvider: embProvider === 'none' ? undefined : embProvider, embeddingModel: embModel || undefined };
  if (s.port) settingsPayload.port = s.port;
  // Workspace save location. Like port, it persists to config.json and takes
  // effect on restart — the migration of existing files runs at next boot,
  // when the old app instance has released the folder.
  const wsEl = document.getElementById('cfg-workspace');
  const wsVal = wsEl?.value?.trim();
  if (wsVal) settingsPayload.workspace = wsVal;
  const customUrl = document.getElementById('cfg-custom-url');
  if (customUrl && customUrl.value) settingsPayload.customBaseUrl = customUrl.value;
  await apiPost('/api/settings', settingsPayload);
  // If port changed, tell user to restart the app
  if (s.port && String(s.port) !== String(currentPort)) {
    alert('Port changed to ' + s.port + '. Please quit and relaunch Local Agent X for this to take effect.');
  }
  // If workspace changed, tell user to restart — files migrate on next boot.
  if (wsVal && wsEl && wsVal !== wsEl.dataset.loaded) {
    alert('Workspace changed to ' + wsVal + '. Quit and relaunch Local Agent X — your existing files move to the new location on restart.');
  }
  // Also save sync config to server
  await saveSyncConfig();
  // A saved key/provider may have just added (or switched) a provider — refresh
  // the chat picker so it shows up without a page reload.
  window.refreshProviderPicker?.();
  const el = document.getElementById('save-status');
  if (el) { el.textContent = 'Saved'; setTimeout(() => el.textContent = '', 2000); }
}

async function loadSettings() {
  try {
    // Server is the source of truth — localStorage is just a cache
    let serverSettings = {};
    try { const r = await apiFetch('/api/settings'); serverSettings = await r.json(); } catch {}
    const local = JSON.parse(localStorage.getItem('lax_settings') || '{}');
    const s = { ...local, ...serverSettings };
    // Sync localStorage with server (so they don't fight)
    localStorage.setItem('lax_settings', JSON.stringify(s));
    const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
    set('cfg-port', s.port);
    const portEl = document.getElementById('cfg-port');
    if (portEl && s.port !== undefined) portEl.dataset.loaded = String(s.port);
    // Show the REAL saved workspace (e.g. the relocated Documents path), and
    // stash it so a change can be detected for the confirm-restart prompt.
    set('cfg-workspace', s.workspace);
    const wsEl = document.getElementById('cfg-workspace');
    if (wsEl && s.workspace !== undefined) wsEl.dataset.loaded = s.workspace;
    // The native folder picker only works in the desktop app — hide it in a browser.
    const browseBtn = document.getElementById('cfg-workspace-browse');
    if (browseBtn && !window.desktop?.isDesktop) browseBtn.style.display = 'none';
    set('cfg-provider', s.provider); set('cfg-model', s.model); set('cfg-temperature', s.temperature);
    // Store saved model and trigger provider change to populate dropdown
    const modelInput = document.getElementById('cfg-model');
    if (modelInput && s.model) modelInput.dataset.saved = s.model;
    if (s.provider) onProviderChange(s.provider, true);
    set('cfg-image-engine', s.imageEngine); set('cfg-stt-engine', s.sttEngine);
    set('cfg-tts-engine', s.ttsEngine); set('cfg-tts-voice', s.ttsVoice); set('cfg-sandbox', s.sandbox);
    set('cfg-xtts-voice', s.xttsVoice);
    set('cfg-voice-engine', s.voiceEngine || 'tier4');
    if (typeof refreshVoiceEngineStatus === 'function') refreshVoiceEngineStatus(s.voiceEngine || 'tier4');
    if (typeof loadVoiceTier4Settings === 'function') loadVoiceTier4Settings(s);
    if (typeof refreshVoiceTier4Visibility === 'function') refreshVoiceTier4Visibility(s.voiceEngine || 'tier4');
    if (typeof loadVoicePicker === 'function') loadVoicePicker(s);
    if (typeof syncPttUiFromConfig === 'function') syncPttUiFromConfig();
    // Embedding settings
    set('cfg-emb-provider', s.embeddingProvider || 'ollama');
    set('cfg-emb-model', s.embeddingModel || '');
    onEmbProviderChange(s.embeddingProvider || 'ollama');
    // Show/hide XTTS sections based on engine
    if (s.ttsEngine) onTtsEngineChange(s.ttsEngine);
    // Show local model dropdown if provider is local
    if (s.provider) onProviderChange(s.provider);
  } catch {}
  checkSyncStatus();
}

// ── Server fields that require a restart (workspace location, port) ──
// Picking a new folder or committing a new port pops a confirm-restart prompt
// right then: accept → persist + restart now (the server reboot migrates the
// workspace and rebinds the port); cancel → revert the field. The desktop app
// uses native dialogs + an in-place server restart; a plain browser falls back
// to a save + a manual-restart notice.

async function pickWorkspaceFolder() {
  const wsEl = document.getElementById('cfg-workspace');
  if (!wsEl) return;
  if (!window.desktop?.selectFolder) {
    alert('The folder picker is only available in the desktop app — type the workspace path manually here in the browser.');
    return;
  }
  const picked = await window.desktop.selectFolder({ title: 'Choose workspace folder', defaultPath: wsEl.value || undefined });
  if (!picked) return; // user canceled the OS picker
  const prev = wsEl.dataset.loaded ?? wsEl.value;
  if (picked === prev) { wsEl.value = picked; return; } // unchanged
  wsEl.value = picked;
  await applyServerChangeWithRestart('workspace', picked, prev, wsEl);
}

function onPortFieldChange() {
  const el = document.getElementById('cfg-port');
  if (!el) return;
  const prev = el.dataset.loaded ?? String(location.port || '7007');
  const val = (el.value || '').trim();
  if (!val || val === prev) return; // no real change
  applyServerChangeWithRestart('port', parseInt(val, 10), prev, el);
}

async function applyServerChangeWithRestart(kind, value, prev, el) {
  const human = kind === 'workspace' ? 'workspace location' : 'port';
  const detail = kind === 'workspace'
    ? 'Local Agent X will restart and move your existing files to the new workspace.'
    : 'Local Agent X will restart to listen on the new port.';
  let ok;
  if (window.desktop?.confirm) {
    ok = await window.desktop.confirm({ message: `Apply the new ${human} and restart now?`, detail, okLabel: 'Restart now' });
  } else {
    ok = confirm(`Apply the new ${human}? Local Agent X must restart to take effect.`);
  }
  if (!ok) { el.value = prev; return; } // revert the field — change abandoned
  try {
    await apiPost('/api/settings', { [kind]: value });
    el.dataset.loaded = String(value);
  } catch (e) {
    alert('Failed to save the new ' + human + '.');
    el.value = prev;
    return;
  }
  if (window.desktop?.restartServer) {
    // Reboots the server child (its loadConfig migrates the workspace + rebinds
    // the port) and reloads the window to the new port. Page reloads here.
    await window.desktop.restartServer();
  } else {
    alert('Saved. Quit and relaunch Local Agent X to apply the new ' + human + '.');
  }
}

