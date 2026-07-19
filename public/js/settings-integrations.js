// ── Settings: API Integrations ──
//
// Generic integrations registry (read /api/integrations) with install /
// uninstall / test / delete + a custom-integration adder. UI for any
// service that exposes an OAuth or API-key shape under /api/integrations.

// ── API Integrations ──

let pluginBundles = [];

async function loadPluginBundles() {
  const el = document.getElementById('plugin-bundles-list');
  if (!el) return;
  try {
    const result = await apiJson('/api/plugins');
    pluginBundles = Array.isArray(result) ? result : [];
    if (pluginBundles.length === 0) {
      el.innerHTML = '<p style="color:var(--muted)">No plugin bundles installed.</p>';
      return;
    }
    el.innerHTML = pluginBundles.map(plugin => {
      const needsSecrets = plugin.status === 'needs_secrets';
      const actions = plugin.actions && typeof plugin.actions === 'object' ? plugin.actions : {};
      const missing = Array.isArray(plugin.missingSecrets) ? plugin.missingSecrets : [];
      const declared = Array.isArray(plugin.declaredTools) ? plugin.declaredTools : (Array.isArray(plugin.tools) ? plugin.tools : []);
      const active = Array.isArray(plugin.activeTools) ? plugin.activeTools : [];
      const registryId = plugin.registryId || plugin.id;
      const identity = [plugin.version ? `v${esc(plugin.version)}` : '', plugin.publisher ? esc(plugin.publisher) : ''].filter(Boolean).join(' · ');
      const detail = needsSecrets
        ? `Needs ${missing.map(esc).join(', ')}`
        : `${active.length}/${declared.length} tools active`;
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg2)">
          <div style="min-width:0">
            <div style="font-family:var(--mono);font-size:.85rem;font-weight:600;color:var(--text)">${esc(plugin.name || plugin.id)}${identity ? ` <span style="font-weight:400;color:var(--muted)">${identity}</span>` : ''}</div>
            <div style="font-size:.7rem;color:var(--muted);margin-top:2px">${detail}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <span style="font-size:.65rem;padding:3px 8px;border-radius:4px;background:${needsSecrets ? 'var(--warn)' : 'var(--border)'};color:${needsSecrets ? '#000' : 'var(--muted)'}">${needsSecrets ? 'NEEDS SECRETS' : esc(String(plugin.status || '').toUpperCase())}</span>
            ${actions.configureSecrets ? `<button class="btn" data-plugin-configure-secrets data-plugin-id="${esc(plugin.id)}" onclick="openPluginSecrets(this.dataset.pluginId)" style="padding:4px 10px;font-size:.7rem;color:var(--accent)">Add Secrets</button>` : ''}
            ${actions.retry ? `<button class="btn" data-plugin-retry data-plugin-id="${esc(plugin.id)}" onclick="retryPluginBundle(this.dataset.pluginId)" style="padding:4px 10px;font-size:.7rem">Retry</button>` : ''}
            ${actions.enable ? `<button class="btn" data-plugin-enable data-plugin-id="${esc(registryId)}" onclick="enablePluginBundle(this.dataset.pluginId)" style="padding:4px 10px;font-size:.7rem;color:var(--accent)">Enable</button>` : ''}
            ${actions.disable ? `<button class="btn" data-plugin-disable data-plugin-id="${esc(registryId)}" onclick="disablePluginBundle(this.dataset.pluginId)" style="padding:4px 10px;font-size:.7rem;color:var(--danger)">Disable</button>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch {
    el.innerHTML = '<p style="color:var(--danger)">Failed to load plugin bundles.</p>';
  }
}

function openPluginSecrets(id) {
  const plugin = pluginBundles.find(item => item.id === id && item.actions?.configureSecrets === true);
  if (!plugin) return;
  const requirements = Array.isArray(plugin.requiredSecrets) ? plugin.requiredSecrets : [];
  const missing = new Set(Array.isArray(plugin.missingSecrets) ? plugin.missingSecrets : []);
  document.getElementById('plugin-secret-modal')?.remove();
  const fields = requirements.filter(item => missing.has(item.name)).map(item => `
    <div style="margin-bottom:12px">
      <label style="font-size:.72rem;color:var(--muted);display:block;margin-bottom:4px">${esc(item.service || item.name)} (${esc(item.name)})</label>
      ${item.description ? `<div style="font-size:.68rem;color:var(--muted);margin-bottom:5px">${esc(item.description)}</div>` : ''}
      <input type="password" data-plugin-secret="${esc(item.name)}" data-plugin-service="${esc(item.service || '')}" class="field-input" autocomplete="off" placeholder="Enter secret" style="width:100%"/>
    </div>`).join('');
  document.body.insertAdjacentHTML('beforeend', `
    <div id="plugin-secret-modal" style="position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999" onclick="if(event.target===this)this.remove()">
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:500px;width:90%">
        <div style="font-size:1.1rem;font-weight:600;color:var(--text);margin-bottom:16px">Set Up ${esc(plugin.name || plugin.id)}</div>
        ${fields}
        <div data-plugin-secret-error style="display:none;color:var(--danger);font-size:.72rem;margin-bottom:10px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="action-btn secondary" onclick="document.getElementById('plugin-secret-modal').remove()">Cancel</button>
          <button class="action-btn primary" data-plugin-save data-plugin-id="${esc(plugin.id)}" onclick="savePluginSecrets(this.dataset.pluginId)">${plugin.enabled === false ? 'Save' : 'Save &amp; Retry'}</button>
        </div>
      </div>
    </div>`);
  document.querySelector('#plugin-secret-modal input')?.focus();
}

function pluginPostSucceeded(result) {
  return !!result && result.ok === true && !result.error;
}

function showPluginSecretError(modal) {
  const status = modal?.querySelector('[data-plugin-secret-error]');
  if (!status) return;
  status.textContent = 'Setup could not be completed. Check the values and try again.';
  status.style.display = 'block';
}

async function savePluginSecrets(id) {
  const plugin = pluginBundles.find(item => item.id === id && item.actions?.configureSecrets === true);
  if (!plugin) return;
  const modal = document.getElementById('plugin-secret-modal');
  const inputs = [...(modal?.querySelectorAll('[data-plugin-secret]') || [])];
  if (inputs.some(input => !input.value.trim())) { alert('Enter every required secret.'); return; }
  const saveButton = modal?.querySelector('[data-plugin-save]');
  if (saveButton) saveButton.disabled = true;
  try {
    for (const input of inputs) {
      const result = await apiPost('/api/secrets', {
        name: input.dataset.pluginSecret,
        value: input.value,
        service: input.dataset.pluginService || undefined,
      });
      if (!pluginPostSucceeded(result)) { showPluginSecretError(modal); return; }
    }
    if (plugin.enabled !== false) {
      const retry = await apiPost('/api/plugins/retry', { id });
      if (!pluginPostSucceeded(retry)) { showPluginSecretError(modal); return; }
    }
    modal?.remove();
    await loadPluginBundles();
  } catch {
    showPluginSecretError(modal);
  } finally {
    if (saveButton?.isConnected) saveButton.disabled = false;
  }
}

async function retryPluginBundle(id) {
  try {
    const result = await apiPost('/api/plugins/retry', { id });
    if (!pluginPostSucceeded(result)) throw new Error("retry failed");
    await loadPluginBundles();
  } catch {
    alert('Plugin retry could not be completed.');
  }
}

async function disablePluginBundle(id) {
  try {
    const result = await apiPost('/api/plugins/unload', { id });
    if (!pluginPostSucceeded(result)) throw new Error("disable failed");
    await loadPluginBundles();
  } catch {
    alert('Plugin disable could not be completed.');
  }
}

async function enablePluginBundle(id) {
  try {
    const result = await apiPost('/api/plugins/enable', { id });
    if (!pluginPostSucceeded(result)) throw new Error("enable failed");
    await loadPluginBundles();
  } catch {
    alert('Plugin enable could not be completed.');
  }
}

async function loadIntegrations() {
  loadPluginBundles();
  const el = document.getElementById('integrations-list');
  if (!el) return;
  try {
    const list = await apiJson('/api/integrations');
    if (!Array.isArray(list) || list.length === 0) { el.innerHTML = '<p style="color:var(--muted)">No integrations available. Restart the server if you just updated.</p>'; return; }
    el.innerHTML = list.map(i => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg2)">
        <div style="display:flex;align-items:center;gap:10px;flex:1">
          <span style="font-size:1.4rem">${esc(i.icon || '🔌')}</span>
          <div>
            <div style="font-family:var(--mono);font-size:.85rem;font-weight:600;color:var(--text)">${esc(i.name)}</div>
            <div style="font-size:.7rem;color:var(--muted);margin-top:2px">${esc(i.description)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:.65rem;padding:3px 8px;border-radius:4px;background:${i.installed ? 'var(--accent)' : 'var(--border)'};color:${i.installed ? '#000' : 'var(--muted)'}">${i.installed ? 'CONNECTED' : 'NOT SET UP'}</span>
          ${i.installed
            ? `<button class="btn" onclick="testIntegration('${esc(i.id)}')" title="Test" style="padding:4px 8px;font-size:.7rem">Test</button>
               <button class="btn" onclick="uninstallIntegration('${esc(i.id)}')" title="Disconnect" style="padding:4px 8px;font-size:.7rem;color:var(--danger)">&#10005;</button>`
            : `<button class="btn" onclick="showInstallModal('${esc(i.id)}')" style="padding:4px 10px;font-size:.7rem;color:var(--accent)" aria-label="Set up ${esc(i.name)}">Set Up ${esc(i.name)}</button>`
          }
          ${!i.builtin ? `<button class="btn" onclick="deleteIntegration('${esc(i.id)}')" title="Remove" style="padding:4px 8px;font-size:.7rem;color:var(--danger)">🗑</button>` : ''}
        </div>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = '<p style="color:var(--danger)">Failed to load integrations.</p>';
  }
}

async function showInstallModal(id) {
  try {
    const config = await apiJson('/api/integrations/' + id);
    const instructions = esc(config.authInstructions || '').replace(/\n/g, '<br>');
    const html = `
      <div id="install-modal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999" onclick="if(event.target===this)this.remove()">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:500px;width:90%">
          <div style="font-size:1.1rem;font-weight:600;color:var(--text);margin-bottom:4px">${esc(config.icon)} Set Up ${esc(config.name)}</div>
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:16px">${esc(config.description)}</div>
          <div style="font-size:.72rem;color:var(--text);line-height:1.8;margin-bottom:16px;padding:12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
            <div style="color:var(--accent);font-weight:600;margin-bottom:6px">How to get your credentials:</div>
            ${instructions}
          </div>
          <div style="margin-bottom:12px">
            <label style="font-size:.72rem;color:var(--muted);display:block;margin-bottom:4px">API Key / Token (${esc(config.secretName)})</label>
            <input type="password" id="install-secret-value" class="field-input" placeholder="Paste your key or token here" style="width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:10px;border-radius:6px;font-family:var(--mono);font-size:.8rem" autocomplete="off"/>
          </div>
          ${config.docsUrl ? `<div style="margin-bottom:16px"><a href="${/^https?:\/\//i.test(config.docsUrl || '') ? esc(config.docsUrl) : '#'}" target="_blank" style="font-size:.72rem;color:var(--accent)">📄 Official API Docs →</a></div>` : ''}
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="action-btn secondary" onclick="document.getElementById('install-modal').remove()">Cancel</button>
            <button class="action-btn primary" onclick="doInstallIntegration('${config.id}')">Connect</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    document.getElementById('install-secret-value')?.focus();
  } catch (e) {
    console.error('Failed to load integration:', e);
  }
}

async function doInstallIntegration(id) {
  const input = document.getElementById('install-secret-value');
  const value = input?.value?.trim();
  if (!value) { alert('Please enter your API key or token.'); return; }
  try {
    await apiPost('/api/integrations/install', { id, secretValue: value });
    document.getElementById('install-modal')?.remove();
    loadIntegrations();
  } catch (e) {
    alert('Install failed: ' + e.message);
  }
}

async function uninstallIntegration(id) {
  if (!confirm('Disconnect this integration? The API key will be removed from your secrets vault.')) return;
  try {
    await apiPost('/api/integrations/uninstall', { id });
    loadIntegrations();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function testIntegration(id) {
  try {
    const r = await apiPost('/api/integrations/test', { id });
    if (r.ok) {
      alert('Connection successful! (HTTP ' + r.status + ')');
    } else {
      alert('Connection failed: ' + (r.error || 'HTTP ' + r.status + ' ' + r.statusText));
    }
  } catch (e) {
    alert('Test failed: ' + e.message);
  }
}

async function deleteIntegration(id) {
  if (!confirm('Remove this custom integration?')) return;
  try {
    await apiFetch('/api/integrations/' + id, { method: 'DELETE' });
    loadIntegrations();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function addCustomIntegration() {
  const id = document.getElementById('int-new-id')?.value?.trim();
  const name = document.getElementById('int-new-name')?.value?.trim();
  const baseUrl = document.getElementById('int-new-url')?.value?.trim();
  const docsUrl = document.getElementById('int-new-docs')?.value?.trim();
  const authType = document.getElementById('int-new-auth')?.value;
  const secretName = document.getElementById('int-new-secret')?.value?.trim()?.toUpperCase()?.replace(/[^A-Z0-9_]/g, '_');
  if (!id || !name || !baseUrl) { alert('ID, Name, and Base URL are required.'); return; }
  try {
    await apiPost('/api/integrations', {
      id, name, description: name + ' API', icon: '🔌',
      authType: authType || 'bearer_token',
      authInstructions: 'Add your API key for ' + name,
      baseUrl, docsUrl: docsUrl || '',
      secretName: secretName || (id.toUpperCase() + '_API_KEY'),
      endpoints: [], headers: {},
    });
    // Clear form
    ['int-new-id','int-new-name','int-new-url','int-new-docs','int-new-secret'].forEach(fid => {
      const el = document.getElementById(fid); if (el) el.value = '';
    });
    loadIntegrations();
  } catch (e) { alert('Failed: ' + e.message); }
}

// WhatsApp Bridge UI moved to /js/settings-whatsapp.js
// Telegram Bot UI moved to /js/settings-telegram.js

