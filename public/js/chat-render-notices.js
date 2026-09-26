// Delete notices — files the agent deleted to the trash WITHOUT a card, because
// this request created them and the user did not name them
// (src/tool-execution/unnamed-delete-gate.ts). The trade for skipping the card
// is that the user sees exactly what went, and can put it back in one click.
// Rendered outside the collapsible activity block by chat-render-artifacts.js;
// saved on the row by chat-stream-finalize.js, so Undo survives a reload.
//
// Exposes (global): renderDeleteNotice(notice)

function _noticeBaseName(p) {
  const parts = String(p || '').split(/[\\/]/);
  return parts[parts.length - 1] || String(p || '');
}

function renderDeleteNotice(n) {
  const el = document.createElement('div');
  el.className = 'delete-notice';
  el.setAttribute('data-id', n.id || '');
  const files = Array.isArray(n.files) ? n.files : [];
  const count = files.length + ' file' + (files.length === 1 ? '' : 's');
  const names = files.map(f => '<span class="delete-notice-file" title="' + esc(f) + '">' + esc(_noticeBaseName(f)) + '</span>').join(', ');

  const paint = () => {
    if (n.restored) {
      el.classList.add('restored');
      el.innerHTML = '<span class="delete-notice-text">Restored ' + count + ': ' + names + '.</span>';
      return;
    }
    el.innerHTML =
      '<span class="delete-notice-text">Deleted ' + count + ' this request created, which you didn’t name: '
      + names + '. They’re in the trash.</span>'
      + '<button class="delete-notice-undo" type="button">Undo</button>'
      + (n.error ? '<div class="delete-notice-error">' + esc(n.error) + '</div>' : '');
    el.querySelector('.delete-notice-undo').addEventListener('click', undo);
  };

  const undo = async () => {
    const btn = el.querySelector('.delete-notice-undo');
    if (btn) { btn.disabled = true; btn.textContent = 'Restoring…'; }
    try {
      const sessionId = (window.activeChat && window.activeChat.id) || undefined;
      const res = await apiFetch('/api/trash/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: files, sessionId }),
      });
      const data = await res.json();
      const failed = (data.results || []).filter(r => r.error);
      if (!res.ok || failed.length) {
        n.error = failed.length ? failed.map(r => r.error).join(' ') : (data.error || 'Restore failed.');
      } else {
        n.restored = true;
        delete n.error;
      }
    } catch (err) {
      n.error = 'Restore failed: ' + (err && err.message ? err.message : String(err));
    }
    try { if (typeof saveChats === 'function') saveChats(); } catch { /* the notice still shows the outcome */ }
    paint();
  };

  paint();
  return el;
}
