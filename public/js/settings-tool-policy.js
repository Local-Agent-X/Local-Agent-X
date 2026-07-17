// ── Settings: Tool Policy category toggles ──
//
// Three boolean kill-switches (Shell, HTTP, Browser) that the server
// enforces at tool-pre-dispatch. Persists through the generic
// /api/settings endpoint — the runtime-settings schema in
// src/settings-schema.ts mirrors these into config.json + ctx.config so
// the gate reads the live value on the very next tool call (no restart).

async function loadToolPolicyToggles() {
  try {
    const r = await apiFetch('/api/settings');
    if (!r.ok) return;
    const s = await r.json();
    setToolPolicyToggle('tp-toggle-shell',   s.enableShell   !== false);
    setToolPolicyToggle('tp-toggle-http',    s.enableHttp    !== false);
    setToolPolicyToggle('tp-toggle-browser', s.enableBrowser !== false);
    setToolPolicyToggle('tp-toggle-ui-events', s.enableUiEventBus !== false);
    // Supervised browser defaults OFF (=== true) — the browser is autonomous
    // out of the box; supervision is the opt-in.
    setToolPolicyToggle('tp-toggle-supervised-browser', s.supervisedBrowser === true);
    // Computer control + phone remote control both default OFF (=== true).
    setToolPolicyToggle('tp-toggle-computer', s.enableComputerControl === true);
    setToolPolicyToggle('tp-toggle-remote', s.enableRemoteControl === true);
    setToolPolicyToggle('tp-toggle-local-only', s.localOnlyMode === true);
    applyLocalOnlyUi(s.localOnlyMode === true);
    setToolPolicyToggle('cfg-toggle-grok-media', s.preferGrokForMedia !== false);
    // developer_mode defaults OFF (=== true), unlike the kill-switches above
    // which default ON (!== false). The card only renders on installs where
    // self_edit can exist at all (git checkout) — packaged installs hide it.
    const devCard = document.getElementById('dev-mode-card');
    if (devCard) devCard.style.display = s.selfEditAvailable === true ? '' : 'none';
    setToolPolicyToggle('tp-toggle-developer-mode', s.developer_mode === true);
  } catch (e) { console.warn('[tool-policy] load failed', e); }
}

function setToolPolicyToggle(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  if (on) el.classList.add('on'); else el.classList.remove('on');
}

async function toolPolicyToggle(field, el) {
  const willBeOn = !el.classList.contains('on');
  // Optimistic UI flip — revert on failure.
  if (willBeOn) el.classList.add('on'); else el.classList.remove('on');
  try {
    const r = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: willBeOn })
    });
    if (!r.ok) throw new Error('save failed');
    if (field === 'localOnlyMode') applyLocalOnlyUi(willBeOn);
  } catch (e) {
    console.warn('[tool-policy] save failed', e);
    // Revert
    if (willBeOn) el.classList.remove('on'); else el.classList.add('on');
  }
}

function applyLocalOnlyUi(enabled) {
  const status = document.getElementById('local-only-status');
  if (status) status.textContent = enabled
    ? 'On. Cloud providers and auth, internet and subprocess tools, remote MCP, remote connectors and integrations, messaging bridges, account presence, sync, and updates are blocked. Saved choices return when this mode is turned off.'
    : 'Off. Remote providers and integrations may connect when configured.';
  document.querySelectorAll('[data-local-only-auth-title], [data-local-only-update-title]').forEach(title => {
    const card = title.closest('.section-card');
    if (card) card.style.display = enabled ? 'none' : '';
  });
  for (const tab of ['integrations', 'whatsapp', 'sync', 'mobile']) {
    const pill = document.querySelector(`.tab-pill[data-tab="${tab}"]`);
    if (pill) pill.style.display = enabled ? 'none' : '';
  }
  const provider = document.getElementById('cfg-provider');
  if (provider) {
    [...provider.options].forEach(option => {
      option.disabled = enabled && option.value !== 'local' && option.value !== 'custom';
      option.hidden = option.disabled;
    });
    if (enabled && provider.value !== 'local' && provider.value !== 'custom') {
      provider.value = 'local';
      onProviderChange('local', true);
    }
  }
  const embeddings = document.getElementById('cfg-emb-provider');
  if (embeddings) {
    [...embeddings.options].forEach(option => {
      option.disabled = enabled && !['ollama', 'local', 'none'].includes(option.value);
      option.hidden = option.disabled;
    });
    if (enabled && embeddings.selectedOptions[0]?.disabled) {
      embeddings.value = 'local';
      onEmbProviderChange('local');
    }
  }
}

window.applyLocalOnlyUi = applyLocalOnlyUi;

document.addEventListener('DOMContentLoaded', loadToolPolicyToggles);
