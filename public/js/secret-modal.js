// ── Secret modal (single + multi) ──
// Handles both `secret_request` and `secrets_request` SSE events. The modal
// can show 1..N labeled secret fields, grouped by service. While a modal is
// visible, additional secret events are queued and displayed in batch after
// the current one is submitted/cancelled.

(function () {
  let _pendingNames = [];   // names currently rendered in the open modal
  const _queue = [];        // pending {name, service, reason} entries

  function _isOpen() {
    const o = document.getElementById('secret-modal-overlay');
    return !!(o && o.classList.contains('visible'));
  }

  function _esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function _ensureOverlay() {
    let overlay = document.getElementById('secret-modal-overlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'secret-modal-overlay';
    overlay.onclick = e => { if (e.target === overlay) cancelSecret(); };
    document.body.appendChild(overlay);
    return overlay;
  }

  function _renderModalBody(overlay, secrets) {
    const groups = new Map();
    for (const s of secrets) {
      const k = s.service || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }

    const showHeaders = groups.size > 1 || (groups.size === 1 && [...groups.keys()][0] !== '');
    let html = '<div id="secret-modal">';
    html += '<h3 style="font-family:var(--mono);color:var(--accent);font-size:.95rem;margin-bottom:14px">Secret' + (secrets.length > 1 ? 's' : '') + ' Requested</h3>';

    for (const [service, items] of groups) {
      if (showHeaders) {
        html += '<div style="color:var(--accent);font-size:.72rem;font-family:var(--mono);margin:14px 0 8px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border);padding-bottom:4px">' + _esc(service || 'Other') + '</div>';
      }
      for (const s of items) {
        html += '<div style="margin-bottom:14px">';
        html += '<div style="display:inline-block;background:#1a1a30;border:1px solid var(--border);border-radius:6px;padding:3px 10px;font-family:var(--mono);font-size:.74rem;color:var(--accent);margin-bottom:4px">' + _esc(s.name) + '</div>';
        html += '<div style="color:var(--muted);font-size:.78rem;margin:4px 0 6px;line-height:1.4">' + _esc(s.reason) + '</div>';
        html += '<input type="password" data-secret-name="' + _esc(s.name) + '" class="field-input secret-input-field" placeholder="Paste value..." autocomplete="off"/>';
        html += '</div>';
      }
    }

    html += '<div style="font-size:.7rem;color:var(--muted);margin-top:8px">Encrypted and stored locally. Never appears in chat.</div>';
    html += '<div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">';
    html += '<button class="action-btn secondary" onclick="cancelSecret()">Cancel</button>';
    html += '<button class="action-btn primary" onclick="submitSecret()">Save</button>';
    html += '</div></div>';
    overlay.innerHTML = html;

    overlay.querySelectorAll('.secret-input-field').forEach(inp => {
      inp.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const inputs = Array.from(overlay.querySelectorAll('.secret-input-field'));
        const stillEmpty = inputs.find(i => !i.value.trim());
        if (stillEmpty && stillEmpty !== e.target) { stillEmpty.focus(); return; }
        submitSecret();
      });
    });
  }

  function _show(secrets) {
    if (!secrets || secrets.length === 0) return;
    _pendingNames = secrets.map(s => s.name);
    const overlay = _ensureOverlay();
    _renderModalBody(overlay, secrets);
    overlay.classList.add('visible');
    setTimeout(() => {
      const first = overlay.querySelector('.secret-input-field');
      if (first) first.focus();
    }, 100);
  }

  function showSecretModal(name, service, reason) {
    showMultiSecretModal([{ name, service, reason }]);
  }

  function showMultiSecretModal(secrets) {
    if (!Array.isArray(secrets) || secrets.length === 0) return;
    if (!_isOpen()) { _show(secrets); return; }
    const newOnes = secrets.filter(s =>
      !_pendingNames.includes(s.name) && !_queue.some(q => q.name === s.name)
    );
    if (newOnes.length === 0) return;
    _queue.push(...newOnes);
  }

  async function submitSecret() {
    const overlay = document.getElementById('secret-modal-overlay');
    if (!overlay) return;
    const inputs = Array.from(overlay.querySelectorAll('.secret-input-field'));
    const empty = inputs.filter(i => !i.value.trim());
    if (empty.length > 0) {
      empty[0].focus();
      empty[0].style.outline = '2px solid #f55';
      setTimeout(() => { empty[0].style.outline = ''; }, 1500);
      return;
    }
    for (const inp of inputs) {
      const name = inp.getAttribute('data-secret-name');
      const value = inp.value.trim();
      if (!name || !value) continue;
      try {
        await apiPost('/api/secrets', { name, value });
      } catch (e) {
        console.error('Failed saving secret', name, e);
      }
    }
    _afterClose();
  }

  function cancelSecret() { _afterClose(); }

  function _afterClose() {
    const o = document.getElementById('secret-modal-overlay');
    if (o) o.classList.remove('visible');
    _pendingNames = [];
    if (_queue.length > 0) {
      const next = _queue.splice(0, _queue.length);
      setTimeout(() => _show(next), 200);
    }
  }

  window.showSecretModal = showSecretModal;
  window.showMultiSecretModal = showMultiSecretModal;
  window.submitSecret = submitSecret;
  window.cancelSecret = cancelSecret;
})();
