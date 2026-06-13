// ── Settings: MCP Servers ──
//
// UI over ~/.lax/mcp.json (read/written by /api/mcp/servers). Lists configured
// MCP servers with live connection status + tool counts, supports add / remove /
// enable-disable / test, and wires missing secrets to the vault. Mirrors the
// Connected APIs card pattern in settings-integrations.js.

// Recommended servers — one-click prefill for the add form. Matches the set in
// docs/mcp-consuming-servers.md. Secrets are referenced as ${secret:NAME}; the
// server is skipped until that secret exists in the vault.
const MCP_CATALOG = [
  { id: 'github', name: 'github', icon: '🐙', command: 'npx', args: '-y @modelcontextprotocol/server-github', env: 'GITHUB_PERSONAL_ACCESS_TOKEN=${secret:GITHUB_TOKEN}' },
  { id: 'postgres', name: 'postgres', icon: '🐘', command: 'npx', args: '-y @modelcontextprotocol/server-postgres ${secret:POSTGRES_URL}', env: '' },
  { id: 'slack', name: 'slack', icon: '💬', command: 'npx', args: '-y @modelcontextprotocol/server-slack', env: 'SLACK_BOT_TOKEN=${secret:SLACK_BOT_TOKEN}' },
  { id: 'puppeteer', name: 'puppeteer', icon: '🎭', command: 'npx', args: '-y @modelcontextprotocol/server-puppeteer', env: '' },
];

function mcpStatusBadge(s) {
  const pill = (bg, color, text) =>
    `<span style="font-size:.65rem;padding:3px 8px;border-radius:4px;background:${bg};color:${color}">${esc(text)}</span>`;
  if (s.redundant) return pill('var(--border)', 'var(--muted)', 'SKIPPED (native)');
  if (s.missingSecrets && s.missingSecrets.length) return pill('var(--warn,#a86)', '#000', 'NEEDS SECRET');
  if (s.disabled) return pill('var(--border)', 'var(--muted)', 'DISABLED');
  if (s.connected) return pill('var(--accent)', '#000', `CONNECTED — ${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}`);
  return pill('var(--border)', 'var(--danger)', 'NOT CONNECTED');
}

async function loadMcpServers() {
  const el = document.getElementById('mcp-servers-list');
  if (!el) return;
  renderMcpCatalog();
  try {
    const data = await apiJson('/api/mcp/servers');
    const servers = (data && data.servers) || [];
    if (servers.length === 0) {
      el.innerHTML = '<p style="color:var(--muted)">No MCP servers configured yet. Add one below.</p>';
      return;
    }
    el.innerHTML = servers.map(s => {
      const cmdLine = esc([s.command].concat(s.args || []).join(' '));
      const secretBtns = (s.missingSecrets || []).map(name =>
        `<button class="btn" onclick="setMcpSecret('${esc(s.name)}','${esc(name)}')" style="padding:4px 8px;font-size:.7rem;color:var(--accent)">Set ${esc(name)}</button>`
      ).join('');
      const toggleBtn = s.redundant ? '' : (s.disabled
        ? `<button class="btn" onclick="toggleMcpServer('${esc(s.name)}',false)" style="padding:4px 8px;font-size:.7rem;color:var(--accent)">Enable</button>`
        : `<button class="btn" onclick="toggleMcpServer('${esc(s.name)}',true)" style="padding:4px 8px;font-size:.7rem">Disable</button>`);
      const tools = (s.connected && s.tools && s.tools.length)
        ? `<div style="font-size:.66rem;color:var(--muted);margin-top:6px;font-family:var(--mono);word-break:break-word">${esc(s.tools.join(', '))}</div>`
        : '';
      // Redundant servers (filesystem) are never spawned — their tools
      // duplicate native read/write/edit. Offering Test/Enable on them makes a
      // by-design skip look like a failure, so show an explanation instead.
      const actions = s.redundant
        ? `<button class="btn" onclick="removeMcpServer('${esc(s.name)}')" title="Remove" style="padding:4px 8px;font-size:.7rem;color:var(--danger)">🗑</button>`
        : `${secretBtns}${toggleBtn}
           <button class="btn" onclick="testMcpServer('${esc(s.name)}')" style="padding:4px 8px;font-size:.7rem">Test</button>
           <button class="btn" onclick="removeMcpServer('${esc(s.name)}')" title="Remove" style="padding:4px 8px;font-size:.7rem;color:var(--danger)">🗑</button>`;
      const note = s.redundant
        ? `<div style="font-size:.68rem;color:var(--muted);margin-top:6px">Not started — native <span style="font-family:var(--mono)">read</span>/<span style="font-family:var(--mono)">write</span>/<span style="font-family:var(--mono)">edit</span> already cover this with full security checks.</div>`
        : '';
      return `
      <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg2);margin-bottom:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="font-family:var(--mono);font-size:.85rem;font-weight:600;color:var(--text)">${esc(s.name)}</div>
            <div style="font-size:.7rem;color:var(--muted);margin-top:2px;font-family:var(--mono);word-break:break-word">${cmdLine}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">${mcpStatusBadge(s)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap">${actions}</div>
        ${note}${tools}
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<p style="color:var(--danger)">Failed to load MCP servers.</p>';
  }
}

function renderMcpCatalog() {
  const el = document.getElementById('mcp-catalog');
  if (!el || el.dataset.rendered) return;
  el.innerHTML = MCP_CATALOG.map(c =>
    `<button class="btn" onclick="prefillMcpServer('${esc(c.id)}')" style="padding:5px 10px;font-size:.72rem">${esc(c.icon)} ${esc(c.name)}</button>`
  ).join('');
  el.dataset.rendered = '1';
}

function prefillMcpServer(id) {
  const c = MCP_CATALOG.find(x => x.id === id);
  if (!c) return;
  const set = (fid, val) => { const e = document.getElementById(fid); if (e) e.value = val; };
  set('mcp-new-name', c.name);
  set('mcp-new-command', c.command);
  set('mcp-new-args', c.args);
  set('mcp-new-env', c.env);
}

function parseMcpEnv(text) {
  const env = {};
  (text || '').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t) return;
    const i = t.indexOf('=');
    if (i < 1) return;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  });
  return env;
}

async function addMcpServer() {
  const name = document.getElementById('mcp-new-name')?.value?.trim();
  const command = document.getElementById('mcp-new-command')?.value?.trim();
  const argsRaw = document.getElementById('mcp-new-args')?.value?.trim() || '';
  const envRaw = document.getElementById('mcp-new-env')?.value || '';
  if (!name || !command) { alert('Server Name and Command are required.'); return; }
  const args = argsRaw ? argsRaw.split(/\s+/) : [];
  const env = parseMcpEnv(envRaw);
  const listEl = document.getElementById('mcp-servers-list');
  if (listEl) listEl.innerHTML = '<p style="color:var(--muted)">Connecting…</p>';
  try {
    await apiPost('/api/mcp/servers', { name, command, args, env });
    ['mcp-new-name', 'mcp-new-command', 'mcp-new-args', 'mcp-new-env'].forEach(fid => {
      const e = document.getElementById(fid); if (e) e.value = '';
    });
    loadMcpServers();
  } catch (e) {
    alert('Failed to add server: ' + e.message);
    loadMcpServers();
  }
}

async function toggleMcpServer(name, disabled) {
  const listEl = document.getElementById('mcp-servers-list');
  if (listEl) listEl.innerHTML = '<p style="color:var(--muted)">Applying…</p>';
  try {
    await apiPost('/api/mcp/servers/toggle', { name, disabled });
  } catch (e) {
    alert('Failed: ' + e.message);
  }
  loadMcpServers();
}

async function testMcpServer(name) {
  try {
    const r = await apiPost('/api/mcp/servers/test', { name });
    if (r.ok) {
      alert(`Connected — ${r.toolCount} tool${r.toolCount === 1 ? '' : 's'}.` + (r.tools && r.tools.length ? `\n\n${r.tools.join(', ')}` : ''));
    } else {
      alert('Test failed: ' + (r.error || 'unknown error'));
    }
  } catch (e) {
    alert('Test failed: ' + e.message);
  }
}

async function removeMcpServer(name) {
  if (!confirm(`Remove MCP server "${name}"? Its tools will be removed from your agent.`)) return;
  try {
    await apiFetch('/api/mcp/servers/' + encodeURIComponent(name), { method: 'DELETE' });
  } catch (e) {
    alert('Failed: ' + e.message);
  }
  loadMcpServers();
}

function setMcpSecret(serverName, secretName) {
  const html = `
    <div id="mcp-secret-modal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999" onclick="if(event.target===this)this.remove()">
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:460px;width:90%">
        <div style="font-size:1.05rem;font-weight:600;color:var(--text);margin-bottom:4px">Set secret for ${esc(serverName)}</div>
        <div style="font-size:.75rem;color:var(--muted);margin-bottom:16px">This value is stored encrypted in your local vault as <span style="font-family:var(--mono);color:var(--accent)">${esc(secretName)}</span> and injected into the server at launch. It never appears in chat or in mcp.json.</div>
        <input type="password" id="mcp-secret-value" class="field-input" placeholder="Paste value for ${esc(secretName)}" style="width:100%;font-family:var(--mono);font-size:.8rem" autocomplete="off"/>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
          <button class="action-btn secondary" onclick="document.getElementById('mcp-secret-modal').remove()">Cancel</button>
          <button class="action-btn primary" onclick="saveMcpSecret('${esc(serverName)}','${esc(secretName)}')">Save &amp; Connect</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('mcp-secret-value')?.focus();
}

async function saveMcpSecret(serverName, secretName) {
  const value = document.getElementById('mcp-secret-value')?.value?.trim();
  if (!value) { alert('Please enter a value.'); return; }
  try {
    await apiPost('/api/secrets', { name: secretName, value });
    document.getElementById('mcp-secret-modal')?.remove();
    // Re-apply: a toggle reload now resolves the freshly-saved secret and
    // connects the server that was being skipped for it.
    await toggleMcpServer(serverName, false);
  } catch (e) {
    alert('Failed to save secret: ' + e.message);
  }
}
