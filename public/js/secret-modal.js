// ── Secret card (single + multi) ──
// Handles both `secret_request` and `secrets_request` SSE events. The card
// renders inline in the chat flow (as the last entry under the agent's
// message) rather than as a floating overlay, so the user can still read what
// the agent said while filling it in. It can show 1..N labeled secret fields,
// grouped by service. While a card is visible, additional secret events are
// queued and displayed in batch after the current one is submitted/cancelled.

(function () {
  let _pendingNames = [];   // names currently rendered in the open card
  const _queue = [];        // pending {name, service, reason} entries
  let _observer = null;     // re-attaches the card if renderMessages() wipes it
  let _cardEl = null;       // live reference to the card (survives innerHTML wipes)

  function _isOpen() {
    return !!(_cardEl && _cardEl.classList.contains('visible'));
  }

  function _esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Home for the inline card: the chat message list, so it scrolls with the
  // conversation and lands under the agent's last bubble. Falls back to body
  // if the chat list isn't mounted (e.g. another view is active).
  function _host() {
    return document.getElementById('messages') || document.body;
  }

  // The newest assistant bubble carries a ~100vh `pin-bottom` min-height
  // reservation (keeps the last reply near the viewport top). Our card appends
  // AFTER that bubble, so the reservation would shove it a full screen down.
  // Collapse the reservation while the card is the live bottom element.
  function _collapsePin() {
    const host = _host();
    host.querySelectorAll('.msg.pin-bottom').forEach(m => m.classList.remove('pin-bottom'));
  }

  function _ensureOverlay() {
    const host = _host();
    if (!_cardEl) {
      _cardEl = document.createElement('div');
      _cardEl.id = 'secret-modal-overlay';
    }
    // Keep it as the last child of the live host (first mount, a chat
    // re-render that dropped it, or a host swap).
    if (_cardEl.parentNode !== host) host.appendChild(_cardEl);
    _collapsePin();
    return _cardEl;
  }

  function _scrollIntoView() {
    if (typeof window.autoScroll === 'function') { window.autoScroll(); return; }
    const el = document.getElementById('messages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  // renderMessages() rebuilds #messages via innerHTML, which would silently
  // drop our card mid-input. While the card is open, watch the host and
  // re-append (preserving typed values) if it gets detached.
  function _startGuard() {
    if (_observer || typeof MutationObserver === 'undefined') return;
    _observer = new MutationObserver(() => {
      if (!_cardEl || !_cardEl.classList.contains('visible')) return;
      const host = _host();
      if (_cardEl.parentNode !== host) {
        host.appendChild(_cardEl);
        _collapsePin();
        _scrollIntoView();
      }
    });
    const host = _host();
    if (host) _observer.observe(host, { childList: true });
  }

  function _stopGuard() {
    if (_observer) { _observer.disconnect(); _observer = null; }
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
    _startGuard();
    _scrollIntoView();
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
    const overlay = _cardEl;
    if (!overlay) return;
    const inputs = Array.from(overlay.querySelectorAll('.secret-input-field'));
    const empty = inputs.filter(i => !i.value.trim());
    if (empty.length > 0) {
      empty[0].focus();
      empty[0].style.outline = '2px solid #f55';
      setTimeout(() => { empty[0].style.outline = ''; }, 1500);
      return;
    }
    const requested = _pendingNames.slice();
    const saved = [];
    for (const inp of inputs) {
      const name = inp.getAttribute('data-secret-name');
      const value = inp.value.trim();
      if (!name || !value) continue;
      try {
        await apiPost('/api/secrets', { name, value });
        saved.push(name);
      } catch (e) {
        console.error('Failed saving secret', name, e);
      }
    }
    _afterClose();
    if (saved.length) {
      _localNote(`${saved.join(', ')} captured and ready for use.`);
    } else {
      _localNote(`Couldn't save ${requested.join(', ') || 'the secret'} — try again.`);
    }
  }

  // Drop an instant confirmation straight into the chat. Client-only: the note
  // is never sent to the model (the agent reads the credential from the vault
  // when it next needs it), so there's no turn latency.
  function _localNote(text) {
    if (!text) return;
    const chat = (typeof activeChat !== 'undefined') ? activeChat : null;
    if (chat && Array.isArray(chat.messages)) {
      chat.messages.push({ role: 'assistant', content: text, timestamp: Date.now(), _localNote: true });
      if (typeof saveChats === 'function') saveChats();
      if (typeof renderMessages === 'function') renderMessages();
      _scrollIntoView();
    } else if (typeof addMessageEl === 'function') {
      addMessageEl('assistant', text);
    }
  }

  function cancelSecret() {
    const requested = _pendingNames.slice();
    _afterClose();
    if (requested.length) _localNote(`${requested.join(', ')} not saved — request cancelled.`);
  }

  function _afterClose() {
    _stopGuard();
    if (_cardEl) {
      _cardEl.classList.remove('visible');
      _cardEl.remove();   // inline card: pull it out of the chat flow entirely
      _cardEl = null;
    }
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
