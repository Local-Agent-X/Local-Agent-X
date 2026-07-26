// ── Settings: API Integrations ──
//
// Generic integrations registry (read /api/integrations) with install /
// uninstall / test / delete + a custom-integration adder. UI for any
// service that exposes an OAuth or API-key shape under /api/integrations.

// ── Shared credential-requirement fields ──
//
// A CredentialRequirement list renders to one field per requirement, and those
// fields collect back into one submission. BOTH credential modals on this page
// — plugin setup and integration install — go through these two functions.
// They were copy-pasted before and the copies drifted: the plugin modal
// hardcoded type="password", so a `secret: false` requirement (non-secret
// config such as SMTP_HOST) rendered as a masked field there and a readable one
// here. `secret: false` means non-secret, so the readable field is the correct
// behaviour and it is now the only behaviour.
//
// `attribute` is the data-attribute each modal identifies its own fields by;
// the rest of the markup is shared verbatim.

function credentialFieldsHtml(requirements, options) {
  const single = requirements.length === 1 && !!options.singleLabel;
  return requirements.map(item => `
          <div style="margin-bottom:12px">
            <label style="font-size:.72rem;color:var(--muted);display:block;margin-bottom:4px">${single ? esc(options.singleLabel) : esc(item.service || item.name)} (${esc(item.name)})${item.required === false ? ' — optional' : ''}</label>
            ${item.description ? `<div style="font-size:.68rem;color:var(--muted);margin-bottom:5px">${esc(item.description)}</div>` : ''}
            <input type="${item.secret === false ? 'text' : 'password'}" ${options.attribute}="${esc(item.name)}"${item.service ? ` data-credential-service="${esc(item.service)}"` : ''}${item.required === false ? ' data-credential-optional' : ''} class="field-input" placeholder="${single ? esc(options.singlePlaceholder) : esc('Enter ' + item.name)}" style="${options.inputStyle || 'width:100%'}" autocomplete="off"/>
          </div>`).join('');
}

/**
 * Reads back the fields credentialFieldsHtml rendered. Returns one entry per
 * FILLED field, or null when a required field is empty — refusing to submit a
 * blank credential is the shared rule; how each modal TELLS the user is not.
 *
 * A field the declaration marked `required: false` may be left blank, and is
 * then OMITTED rather than submitted as "": the install route rejects an
 * explicitly supplied blank, so sending one would only move the refusal to the
 * server. Absent means required, so this changes nothing for a plugin bundle
 * (whose manifest cannot declare `required` at all) or for any single-credential
 * integration.
 */
function collectCredentialValues(root, attribute, onEmpty) {
  const inputs = [...(root?.querySelectorAll('[' + attribute + ']') || [])];
  const entries = [];
  for (const input of inputs) {
    const name = input.getAttribute(attribute);
    const value = input.value?.trim();
    if (!value) {
      if (input.hasAttribute('data-credential-optional')) continue;
      onEmpty(name, inputs.length);
      return null;
    }
    entries.push({ name, value, service: input.dataset.credentialService || undefined });
  }
  return entries;
}

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
  const fields = credentialFieldsHtml(
    requirements.filter(item => missing.has(item.name)),
    { attribute: 'data-plugin-secret' },
  );
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
  const entries = collectCredentialValues(modal, 'data-plugin-secret', () => alert('Enter every required secret.'));
  if (!entries) return;
  const saveButton = modal?.querySelector('[data-plugin-save]');
  if (saveButton) saveButton.disabled = true;
  try {
    for (const entry of entries) {
      const result = await apiPost('/api/secrets', {
        name: entry.name,
        value: entry.value,
        service: entry.service,
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
    // One field per DECLARED credential — most services need one, some (email)
    // need several. A config that genuinely declares NOTHING (a custom
    // integration POSTed with only id/name/baseUrl derives `secretName: ""`)
    // gets no fields at all, because a field named "" collects into a
    // credential the server cannot accept and made such an integration
    // impossible to connect.
    //
    // The `secretName` fallback is DEFENSIVE, not a legacy-compatibility path:
    // the registry converts a pre-list config into a credential list at load
    // time (credentialsFrom() in src/integrations/registry.ts), and derives
    // `secretName` from `credentials[0]` and nothing else — so for anything
    // GET /api/integrations/:id can actually return, an empty list and an empty
    // `secretName` are the same state and this arm is unreachable. It is kept
    // because this modal renders whatever that endpoint hands it, and a
    // hand-authored or future response carrying only `secretName` should render
    // a usable field rather than an empty modal.
    const credentials = Array.isArray(config.credentials) && config.credentials.length > 0
      ? config.credentials
      : (config.secretName ? [{ name: config.secretName }] : []);
    const fields = credentialFieldsHtml(credentials, {
      attribute: 'data-install-secret',
      singleLabel: 'API Key / Token',
      singlePlaceholder: 'Paste your key or token here',
      inputStyle: 'width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:10px;border-radius:6px;font-family:var(--mono);font-size:.8rem',
    });
    const html = `
      <div id="install-modal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999" onclick="if(event.target===this)this.remove()">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:500px;width:90%">
          <div style="font-size:1.1rem;font-weight:600;color:var(--text);margin-bottom:4px">${esc(config.icon)} Set Up ${esc(config.name)}</div>
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:16px">${esc(config.description)}</div>
          <div style="font-size:.72rem;color:var(--text);line-height:1.8;margin-bottom:16px;padding:12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
            <div style="color:var(--accent);font-weight:600;margin-bottom:6px">How to get your credentials:</div>
            ${instructions}
          </div>
          ${fields}
          ${config.docsUrl ? `<div style="margin-bottom:16px"><a href="${/^https?:\/\//i.test(config.docsUrl || '') ? esc(config.docsUrl) : '#'}" target="_blank" style="font-size:.72rem;color:var(--accent)">📄 Official API Docs →</a></div>` : ''}
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="action-btn secondary" onclick="document.getElementById('install-modal').remove()">Cancel</button>
            <button class="action-btn primary" onclick="doInstallIntegration('${config.id}')">Connect</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    document.querySelector('#install-modal [data-install-secret]')?.focus();
  } catch (e) {
    console.error('Failed to load integration:', e);
  }
}

async function doInstallIntegration(id) {
  const entries = collectCredentialValues(
    document.getElementById('install-modal'),
    'data-install-secret',
    (name, count) => alert(count === 1 ? 'Please enter your API key or token.' : 'Please enter a value for ' + name + '.'),
  );
  if (!entries) return;
  const secretValues = {};
  for (const entry of entries) secretValues[entry.name] = entry.value;
  try {
    await apiPost('/api/integrations/install', { id, secretValues });
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

