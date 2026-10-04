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

  const EYE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

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

  function _ensureOverlay() {
    const host = _host();
    if (!_cardEl) {
      _cardEl = document.createElement('div');
      _cardEl.id = 'secret-modal-overlay';
    }
    // Keep it as the last child of the live host (first mount, a chat
    // re-render that dropped it, or a host swap).
    if (_cardEl.parentNode !== host) host.appendChild(_cardEl);
    return _cardEl;
  }

  // An open card is brought into view itself: the chat's follow-scroll tracks
  // the last message, and the card sits below it. (The newest reply's
  // reserved room is dropped while a card is open — app.css, #messages:has.)
  function _scrollIntoView() {
    if (_isOpen() && typeof _cardEl.scrollIntoView === 'function') { _cardEl.scrollIntoView({ block: 'nearest' }); return; }
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
        // A website login names its site: the vault fills it only there.
        const site = _siteOf(s.url);
        if (site) html += '<div style="color:var(--muted);font-size:.74rem;margin:0 0 6px">For ' + _esc(site) + ' only &mdash; filled there by the vault, never shown to the agent.</div>';
        html += '<div class="secret-input-wrap">';
        html += '<input type="password" data-secret-name="' + _esc(s.name) + '" data-secret-url="' + _esc(s.url || '') + '" class="field-input secret-input-field" placeholder="Paste value..." autocomplete="off" spellcheck="false"/>';
        html += '<button type="button" class="secret-reveal" aria-label="Show value" aria-pressed="false" title="Show value">' + EYE_ICON + '</button>';
        html += '</div>';
        html += '</div>';
      }
    }

    html += '<div style="font-size:.7rem;color:var(--muted);margin-top:8px">Encrypted and stored locally. Never appears in chat.</div>';
    html += '<div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">';
    html += '<button class="action-btn secondary" onclick="cancelSecret()">Cancel</button>';
    html += '<button class="action-btn primary" onclick="submitSecret()">Save</button>';
    html += '</div></div>';
    overlay.innerHTML = html;

    // Show / hide what was typed, so the user can check it before saving. Each
    // card starts hidden, and a closed card is discarded, so nothing stays shown.
    overlay.querySelectorAll('.secret-reveal').forEach(btn => {
      btn.addEventListener('click', () => {
        const inp = btn.parentNode.querySelector('.secret-input-field');
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        btn.setAttribute('aria-pressed', String(show));
        btn.setAttribute('aria-label', show ? 'Hide value' : 'Show value');
        btn.title = show ? 'Hide value' : 'Show value';
        inp.focus();
      });
    });

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

  function _siteOf(url) {
    if (!url) return '';
    try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url).host; } catch (_) { return ''; }
  }

  function showSecretModal(name, service, reason, url) {
    showMultiSecretModal([{ name, service, reason, url }]);
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
    const failed = [];
    for (const inp of inputs) {
      const name = inp.getAttribute('data-secret-name');
      const value = inp.value.trim();
      const url = inp.getAttribute('data-secret-url') || '';
      if (!name || !value) continue;
      // apiPost resolves for ANY JSON response, including 401/429/500 error
      // bodies — the POST route's success contract is {ok:true}. Trusting a
      // bare resolve told users "captured and ready for use" while the vault
      // had rejected the save (the GEMINI_API_KEY ×5 incident).
      try {
        const res = await apiPost('/api/secrets', url ? { name, value, url } : { name, value });
        if (res && res.ok) {
          saved.push(name);
        } else {
          failed.push(`${name} (${(res && res.error) || 'unexpected response'})`);
        }
      } catch (e) {
        console.error('Failed saving secret', name, e);
        failed.push(`${name} (${(e && e.message) || 'network error'})`);
      }
    }
    _afterClose();
    const parts = [];
    if (saved.length) parts.push(`I saved ${_list(saved)} in the secrets vault.`);
    if (failed.length) parts.push(`${_list(failed)} didn't save.`);
    parts.push(saved.length ? 'Go ahead.' : 'Ask me again if you still need it.');
    await _tellAgent(saved.length || failed.length ? parts.join(' ') : `${_list(requested) || 'The secret'} didn't save. Ask me again if you still need it.`);
  }

  function _list(names) {
    return names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  // The user's Save or Cancel is their answer to the agent, so it goes to the
  // agent as their message (only names, never a value): it starts the next
  // turn, or reaches a running one, instead of the user having to type "it's
  // saved". A draft in the composer is put back afterwards.
  async function _tellAgent(text) {
    const input = document.getElementById('msg-input');
    if (!input || typeof window.sendMessage !== 'function') { _localNote(text); return; }
    const draft = input.value;
    input.value = text;
    await window.sendMessage();
    if (draft && !input.value) input.value = draft;
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

  async function cancelSecret() {
    const requested = _pendingNames.slice();
    _afterClose();
    if (requested.length) await _tellAgent(`I cancelled the request for ${_list(requested)}; I didn't save ${requested.length > 1 ? 'them' : 'it'}.`);
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
