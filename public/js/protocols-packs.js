// ── Protocols Page: skill packs ──
// Vendor / community skill packs (SKILL.md folders) installed from a GitHub
// repo at a pinned commit — the UI over the same installer the agent's
// protocol(action:"install") tool uses (src/protocols/skills-install.ts via
// /api/protocols/import, /packs, /<name>/refresh). Nothing is read live off the
// network: a pack is previewed, installed at a commit, and an update is a diff
// the user approves here.
//
// Split out of protocols.js (400-LOC gate). Loads BEFORE protocols.js, which
// calls protocolPacksLoad() from protocolLoad(); the render helpers below call
// esc() from protocols.js at click time, after every script has loaded.

let packsList = [];          // rows from /api/protocols/packs
let packPreview = null;      // last dry-run report for the Add form

async function protocolPacksLoad() {
  try { const d = await apiFetch('/api/protocols/packs').then(r => r.json()); packsList = Array.isArray(d.packs) ? d.packs : []; }
  catch (e) { packsList = []; }
  protocolPacksSyncButton();
}

function protocolPacksSyncButton() {
  const b = document.getElementById('protocol-packs-toggle');
  if (b) b.textContent = `Packs (${packsList.length})`;
}

function protocolOpenPacks() {
  selectedName = null; selectedRecord = null; editing = false;
  showProtocolsDetail();
  protocolPacksRender();
}

function packShort(sha) { return String(sha || '').slice(0, 8); }

function protocolPacksRender() {
  const view = document.getElementById('protocol-view');
  if (!view) return;
  const rows = packsList.length ? packsList.map(p => {
    const s = p.source || {};
    const warn = Array.isArray(s.lint) && s.lint.length ? `<div style="color:#e9a93a;font-size:.7rem;margin-top:4px">⚠ ${esc(s.lint.join(' · '))}</div>` : '';
    return `<div class="proto-section" style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <strong style="font-family:var(--mono)">${esc(p.name)}</strong>
        <span class="proto-tag">${esc(s.repo)}@${esc(s.ref)}</span>
        <span class="proto-tag" title="pinned commit">${esc(packShort(s.commit))}</span>
        <span class="proto-tag">${esc(s.license)}${s.licenseAssertedBy ? ' (asserted)' : ''}</span>
        <span style="flex:1"></span>
        <button class="proto-btn" onclick="protocolPackRefresh('${escAttr(p.name)}')">Check for update</button>
        <button class="proto-btn danger" onclick="protocolPackRemove('${escAttr(p.name)}')">Remove</button>
      </div>
      <div class="proto-meta" style="margin:6px 0 0">installed ${esc(String(s.installedAt || '').slice(0, 10))} · ${esc(String((s.files || []).length))} file(s) · <a href="${escAttr(s.url || '')}" target="_blank" rel="noopener">source</a></div>
      ${warn}
      <div id="pack-refresh-${escAttr(p.name)}"></div>
    </div>`;
  }).join('') : '<div class="proto-meta">No packs installed yet.</div>';

  view.innerHTML = `
    <h3 style="margin:0 0 4px">Skill packs</h3>
    <div class="proto-meta">A pack is a repo of SKILL.md folders, installed at a pinned commit. The agent only ever sees what is on disk; updates are diffs you approve here. MIT, Apache-2.0 and CC-BY-4.0 content only.</div>
    <div class="proto-section">
      <h4>Add a pack</h4>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input id="pack-repo" class="proto-edit-input" style="flex:1;min-width:260px" placeholder="owner/repo, owner/repo@tag, or a github.com URL (…/tree/main/skills to take one folder)" onkeydown="if(event.key==='Enter')protocolPackPreview()"/>
        <button class="proto-btn primary" onclick="protocolPackPreview()">Preview</button>
      </div>
      <div id="pack-preview" style="margin-top:10px"></div>
    </div>
    <div class="proto-section">
      <h4>Installed (${packsList.length})</h4>
      ${rows}
    </div>`;
}

async function protocolPackPreview() {
  const repo = (document.getElementById('pack-repo')?.value || '').trim();
  const box = document.getElementById('pack-preview');
  if (!repo || !box) return;
  box.innerHTML = '<div class="proto-meta">Resolving the commit and reading the repo…</div>';
  try {
    const res = await apiFetch('/api/protocols/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, dryRun: true }) });
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
    packPreview = { repo, report: d };
    protocolPackRenderPreview();
  } catch (e) {
    packPreview = null;
    box.innerHTML = `<div style="color:#e88;font-size:.75rem">${esc(e.message)}</div>`;
  }
}

function protocolPackRenderPreview() {
  const box = document.getElementById('pack-preview');
  if (!box || !packPreview) return;
  const r = packPreview.report;
  const needsLicense = r.skipped.some(s => /no license found/.test(s.reason));
  const needsForce = r.skipped.some(s => /pass force:true/.test(s.reason));
  const n = r.notInstalled || {};
  const notInstalled = [
    (n.mcpServers || []).length ? `MCP servers ${n.mcpServers.join(', ')} (add them under Settings → MCP if you want them)` : '',
    n.hooks ? `${n.hooks} hook file(s)` : '', n.agents ? `${n.agents} agent file(s)` : '', n.commands ? `${n.commands} command file(s)` : '',
  ].filter(Boolean);
  box.innerHTML = `
    <div class="proto-meta" style="margin-bottom:8px">${esc(r.repo)}@${esc(r.ref)} resolves to <span class="proto-tag">${esc(packShort(r.commit))}</span> — ${r.installed.length} skill(s) would install, ${r.skipped.length} skipped.</div>
    ${r.installed.map(s => `<div style="font-size:.78rem;margin:4px 0"><strong style="font-family:var(--mono)">${esc(s.name)}</strong> — ${esc(s.description)} <span class="proto-meta" style="display:inline">(${s.files.length} file(s))</span>${s.warnings.length ? `<div style="color:#e9a93a;font-size:.7rem">⚠ ${esc(s.warnings.join(' · '))}</div>` : ''}</div>`).join('')}
    ${r.skipped.map(s => `<div style="font-size:.74rem;color:var(--muted);margin:3px 0">skipped ${esc(s.path)}: ${esc(s.reason)}</div>`).join('')}
    ${notInstalled.length ? `<div class="proto-meta" style="margin-top:6px">Not installed (packs bring SKILL.md folders only): ${esc(notInstalled.join('; '))}.</div>` : ''}
    <div class="proto-actions" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      ${needsLicense ? `<label style="font-size:.74rem">License you assert: <input id="pack-license" class="proto-edit-input" style="width:120px" placeholder="MIT"/></label>` : ''}
      ${needsForce ? `<label style="font-size:.74rem"><input type="checkbox" id="pack-force"/> replace same-named skills that came from elsewhere</label>` : ''}
      <button class="proto-btn primary" onclick="protocolPackInstall()" ${r.installed.length || needsLicense || needsForce ? '' : 'disabled'}>Install</button>
    </div>`;
}

async function protocolPackInstall() {
  if (!packPreview) return;
  const box = document.getElementById('pack-preview');
  const license = (document.getElementById('pack-license')?.value || '').trim();
  const force = !!document.getElementById('pack-force')?.checked;
  box.innerHTML = '<div class="proto-meta">Installing…</div>';
  try {
    const res = await apiFetch('/api/protocols/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: packPreview.repo, ...(license ? { license } : {}), ...(force ? { force } : {}) }) });
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
    packPreview = null;
    await protocolPacksLoad();
    protocolLoad();          // the catalog changed
    protocolPacksRender();
    const after = document.getElementById('pack-preview');
    if (after) after.innerHTML = `<div style="color:#7c9;font-size:.75rem">Installed ${d.installed.length} skill(s) from ${esc(d.repo)} at ${esc(packShort(d.commit))}.${d.skipped.length ? ` Skipped ${d.skipped.length}.` : ''}</div>`;
  } catch (e) {
    box.innerHTML = `<div style="color:#e88;font-size:.75rem">${esc(e.message)}</div>`;
  }
}

async function protocolPackRefresh(name, apply = false) {
  const slot = document.getElementById(`pack-refresh-${name}`);
  if (!slot) return;
  slot.innerHTML = `<div class="proto-meta" style="margin-top:6px">${apply ? 'Updating…' : 'Checking the repo…'}</div>`;
  try {
    const res = await apiFetch(`/api/protocols/${encodeURIComponent(name)}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(apply ? { apply: true } : {}) });
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
    if (d.applied) { await protocolPacksLoad(); protocolLoad(); protocolPacksRender(); return; }
    if (d.upToDate) { slot.innerHTML = `<div style="color:#7c9;font-size:.74rem;margin-top:6px">Up to date with ${esc(d.repo)}@${esc(d.ref)} (${esc(packShort(d.installedCommit))}).</div>`; return; }
    slot.innerHTML = `
      <div class="proto-meta" style="margin:8px 0 4px">${esc(d.repo)}@${esc(d.ref)} moved ${esc(packShort(d.installedCommit))} → ${esc(packShort(d.upstreamCommit))}; changed: ${esc((d.changedFiles || []).join(', ') || 'sibling files only')}</div>
      ${d.patch ? `<pre style="max-height:260px;overflow:auto;font-size:.68rem;background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:8px;white-space:pre-wrap">${esc(d.patch)}</pre>` : ''}
      <div class="proto-actions" style="margin-top:6px"><button class="proto-btn primary" onclick="protocolPackRefresh('${escAttr(name)}', true)">Apply update</button></div>`;
  } catch (e) {
    slot.innerHTML = `<div style="color:#e88;font-size:.74rem;margin-top:6px">${esc(e.message)}</div>`;
  }
}

async function protocolPackRemove(name) {
  if (!confirm(`Remove the installed pack "${name}"? Your own protocols are untouched; the pack can be installed again from its repo.`)) return;
  try {
    const res = await apiFetch(`/api/protocols/packs/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
    await protocolPacksLoad();
    protocolLoad();
    protocolPacksRender();
  } catch (e) {
    alert(`Remove failed: ${e.message}`);
  }
}
