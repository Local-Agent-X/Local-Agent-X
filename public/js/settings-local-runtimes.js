// ── Settings: Local Runtimes (manual endpoint registry) ──
//
// List editor over settings.localRuntimes via the EXISTING server API
// (GET/POST/DELETE /api/local-runtimes — routes/settings/providers.ts).
// Each entry is an exact host:port the operator names by hand; the server
// side is the source of truth for validation, dedupe, and the local-only
// guard. The automatic loopback sweep never appears here — this editor
// manages MANUAL entries only.

async function loadLocalRuntimesEditor() {
  const list = document.getElementById('local-runtimes-list');
  if (!list) return;
  if (!list.dataset.wired) {
    // One delegated listener; rows re-render freely. Avoids inline onclick
    // with URL arguments (quote-escaping hazard).
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-lr-remove]');
      if (btn) removeLocalRuntime(btn.getAttribute('data-lr-remove'));
    });
    list.dataset.wired = '1';
  }
  try {
    const data = await apiJson('/api/local-runtimes');
    const manual = data.manual || [];
    const discovered = data.runtimes || [];
    if (manual.length === 0) {
      list.innerHTML = '<div style="font-size:.75rem;color:var(--muted)">No manual runtimes yet. Loopback servers on known ports are found automatically.</div>';
      return;
    }
    list.innerHTML = manual.map((m) => {
      const live = discovered.find((r) => r.endpoint && r.endpoint.baseUrl === m.baseUrl);
      const status = live
        ? `<span class="status-badge ok"><span class="status-dot"></span> Connected · ${live.models.length} model${live.models.length === 1 ? '' : 's'}</span>`
        : '<span class="status-badge err"><span class="status-dot"></span> Not reachable</span>';
      return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:.78rem">
        <span style="min-width:110px;color:var(--muted)">${esc(m.kind)}</span>
        <span style="flex:1;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(m.baseUrl)}">${esc(m.baseUrl)}${m.label ? ` <span style="color:var(--muted)">· ${esc(m.label)}</span>` : ''}</span>
        ${status}
        <button class="btn" data-lr-remove="${esc(m.baseUrl)}" style="padding:3px 10px;font-size:.7rem;color:var(--err, #c66)">Remove</button>
      </div>`;
    }).join('');
  } catch {
    list.innerHTML = '<div style="font-size:.75rem;color:var(--err, #c66)">Failed to load runtimes.</div>';
  }
}

async function addLocalRuntime() {
  const kindEl = document.getElementById('lr-add-kind');
  const urlEl = document.getElementById('lr-add-url');
  const labelEl = document.getElementById('lr-add-label');
  const status = document.getElementById('lr-add-status');
  const btn = document.getElementById('lr-add-btn');
  if (!kindEl || !urlEl) return;
  const baseUrl = urlEl.value.trim();
  if (!baseUrl) { if (status) { status.textContent = 'Enter a base URL first.'; status.style.color = 'var(--err, #c66)'; } return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  if (status) { status.textContent = ''; }
  try {
    const body = { kind: kindEl.value, baseUrl };
    const label = labelEl ? labelEl.value.trim() : '';
    if (label) body.label = label;
    const j = await apiPost('/api/local-runtimes', body);
    if (j && j.ok) {
      if (status) {
        status.textContent = j.reachable ? 'Added and reachable.' : 'Added — not reachable right now (saved; it will appear once the server responds).';
        status.style.color = j.reachable ? 'var(--accent)' : 'var(--muted)';
      }
      urlEl.value = ''; if (labelEl) labelEl.value = '';
      await loadLocalRuntimesEditor();
      window.refreshProviderPicker?.();
    } else if (status) {
      status.textContent = (j && j.error) || 'Failed to add runtime.';
      status.style.color = 'var(--err, #c66)';
    }
  } catch (e) {
    if (status) { status.textContent = 'Failed: ' + (e?.message || e); status.style.color = 'var(--err, #c66)'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
  }
}

async function removeLocalRuntime(baseUrl) {
  if (!baseUrl) return;
  try {
    await apiFetch('/api/local-runtimes?baseUrl=' + encodeURIComponent(baseUrl), { method: 'DELETE' });
  } catch {}
  await loadLocalRuntimesEditor();
  window.refreshProviderPicker?.();
}
