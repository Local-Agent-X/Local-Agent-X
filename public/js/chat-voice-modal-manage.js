// ── Chat: Manage Clones Modal ──
//
// Modal listing all trained SoVITS / Chatterbox clones, allowing rename
// or delete. Calls into /api/voices/sovits and /api/voices/chatterbox.

function openManageClonesModal() {
  const existing = document.getElementById('manage-clones-modal');
  if (existing) existing.remove();

  // Show clones from both providers — sovits (trained ★) first, then
  // chatterbox (zero-shot). Each row is tagged with its provider so the
  // rename/delete buttons hit the right /api/voices/<provider>/ endpoint.
  const sv = (Array.isArray(window._sovitsVoices) ? window._sovitsVoices : [])
    .map(c => ({ ...c, provider: 'sovits' }));
  const cb = (Array.isArray(window._chatterboxVoices) ? window._chatterboxVoices : [])
    .map(c => ({ ...c, provider: 'chatterbox' }));
  const all = [...sv, ...cb];

  const renderRow = (c) => {
    const tag = c.provider === 'sovits'
      ? (c.fine_tuned ? '<span style="font-size:.7rem;color:#3fcf6f">★ trained</span>' : '<span style="font-size:.7rem;color:#9ed3ff">zero-shot</span>')
      : '<span style="font-size:.7rem;color:#9ed3ff">chatterbox</span>';
    return `
      <div class="mc-row" data-id="${esc(c.id)}" data-provider="${esc(c.provider)}" data-name="${esc(c.name)}" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border, #eee)">
        <div style="flex:1;min-width:0">
          <div class="mc-name" style="font-size:.88rem">${esc(c.name)}</div>
          <div style="font-size:.7rem;color:var(--muted,#666);margin-top:2px;font-family:var(--mono)">${esc(c.id)} · ${tag}</div>
        </div>
        <button class="mc-rename" type="button" title="Rename" style="padding:6px 10px;border:1px solid #4a9eff;background:transparent;color:#4a9eff;border-radius:6px;cursor:pointer;font-size:.78rem">Rename</button>
        <button class="mc-delete" type="button" title="Delete" style="padding:6px 10px;border:none;background:#e74c3c;color:#fff;border-radius:6px;cursor:pointer;font-size:.78rem">Delete</button>
      </div>`;
  };
  const rows = all.length === 0
    ? `<div style="padding:16px;color:var(--muted, #666);font-size:.85rem;text-align:center">No cloned voices installed.</div>`
    : all.map(renderRow).join('');

  const modal = document.createElement('div');
  modal.id = 'manage-clones-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg, #fff);color:var(--text, #000);border:1px solid var(--border, #ccc);border-radius:10px;padding:0;max-width:520px;width:94%;max-height:80vh;display:flex;flex-direction:column">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border, #eee)">
        <h3 style="margin:0;font-size:1.05rem">Manage cloned voices</h3>
        <p style="margin:4px 0 0;color:var(--muted, #666);font-size:.78rem">Rename or remove cloned voices. Delete frees the voice's model files from disk.</p>
      </div>
      <div id="mc-rows" style="overflow:auto;flex:1">${rows}</div>
      <div id="mc-status" style="padding:0 18px;font-size:.78rem;color:var(--muted, #666);min-height:1em"></div>
      <div style="padding:12px 18px;border-top:1px solid var(--border, #eee);display:flex;justify-content:flex-end">
        <button id="mc-close" type="button" style="padding:8px 14px;border:1px solid var(--border, #ccc);background:transparent;color:var(--text, #000);border-radius:6px;cursor:pointer">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.getElementById('mc-close').onclick = () => modal.remove();
  const statusEl = document.getElementById('mc-status');

  modal.querySelectorAll('.mc-rename').forEach(btn => {
    btn.onclick = async () => {
      const row = btn.closest('.mc-row');
      const id = row.dataset.id;
      const provider = row.dataset.provider;
      // Use the dataset attribute (single source of truth) instead of
      // reading textContent — the row container has TWO inner divs (name +
      // id badge) and querying the first child grabbed both, which is how
      // a previous rename ended up with garbage like "Jarvis* (trained)\n
      // 69970259a38c · ★ trained" stored as the name.
      const currentName = row.dataset.name || '';
      const next = prompt('New name for "' + currentName + '":', currentName);
      if (next === null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === currentName) return;
      btn.disabled = true; statusEl.textContent = 'Renaming…'; statusEl.style.color = 'var(--muted,#666)';
      try {
        const r = await apiFetch('/api/voices/' + provider + '/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { statusEl.textContent = 'Failed: ' + (data.error || ('HTTP ' + r.status)); statusEl.style.color = '#c0392b'; btn.disabled = false; return; }
        row.querySelector('.mc-name').textContent = trimmed;
        row.dataset.name = trimmed;
        await refreshClonedVoices();
        if (typeof updateStatusBar === 'function') updateStatusBar();
        statusEl.textContent = `Renamed to "${trimmed}".`;
        btn.disabled = false;
      } catch (e) {
        statusEl.textContent = 'Failed: ' + e.message; statusEl.style.color = '#c0392b';
        btn.disabled = false;
      }
    };
  });

  modal.querySelectorAll('.mc-delete').forEach(btn => {
    btn.onclick = async () => {
      const row = btn.closest('.mc-row');
      const id = row.dataset.id;
      const provider = row.dataset.provider;
      if (!confirm(`Delete this voice? Removes its model files from disk. (${id})`)) return;
      btn.disabled = true; statusEl.textContent = 'Deleting…'; statusEl.style.color = 'var(--muted, #666)';
      try {
        const r = await apiFetch('/api/voices/' + provider + '/' + encodeURIComponent(id), { method: 'DELETE' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { statusEl.textContent = 'Failed: ' + (data.error || ('HTTP ' + r.status)); statusEl.style.color = '#c0392b'; btn.disabled = false; return; }
        row.remove();
        const fullId = (provider === 'sovits' ? 'sv:' : 'cb:') + id;
        if (localStorage.getItem('lax_voice') === fullId) {
          localStorage.setItem('lax_voice', 'am_michael');
        }
        await refreshClonedVoices();
        if (typeof updateStatusBar === 'function') updateStatusBar();
        statusEl.textContent = `Deleted.`;
      } catch (e) {
        statusEl.textContent = 'Failed: ' + e.message; statusEl.style.color = '#c0392b';
        btn.disabled = false;
      }
    };
  });
}

