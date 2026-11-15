// Reply on an inbox item: a box under the item, and Send opens the chat about
// it (POST /api/inbox/reply, src/inbox/reply.ts). The first reply starts a new
// chat with the item quoted; a later one continues that chat. Either way the
// chat opens, so the answer streams where the user is looking.
(function () {
  function closeReply(row) {
    var box = row.querySelector('.notif-reply');
    if (box) box.remove();
  }

  async function sendReply(row, id, textarea, sendBtn) {
    var text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Opening chat…';
    try {
      var res = await apiFetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, text: text }),
      });
      var data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      var list = typeof chats !== 'undefined' && Array.isArray(chats) ? chats : null;
      if (list && !list.some(function (c) { return c.id === data.sessionId; })) {
        var item = typeof findInboxItem === 'function' ? findInboxItem(id) : null;
        list.unshift({ id: data.sessionId, title: 'Re: ' + (item ? item.title : 'inbox'), messages: [], createdAt: Date.now(), updatedAt: Date.now() });
        if (typeof saveChats === 'function') saveChats();
        if (typeof renderSidebar === 'function') renderSidebar();
      }
      closeReply(row);
      if (typeof window.selectChat === 'function') window.selectChat(data.sessionId);
    } catch (e) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      var err = row.querySelector('.notif-reply-error');
      if (err) err.textContent = "Couldn't open the chat: " + (e && e.message);
    }
  }

  function openInboxReply(row, id) {
    if (row.querySelector('.notif-reply')) { closeReply(row); return; }
    var box = document.createElement('div');
    box.className = 'notif-reply';
    box.innerHTML = '<textarea class="notif-reply-text" rows="2" placeholder="Reply to your agent about this…"></textarea>'
      + '<div class="notif-reply-row"><button type="button" class="notif-btn notif-reply-send">Send</button>'
      + '<button type="button" class="notif-btn notif-reply-cancel">Cancel</button>'
      + '<span class="notif-reply-error" aria-live="polite"></span></div>';
    row.appendChild(box);
    var textarea = box.querySelector('textarea');
    var send = box.querySelector('.notif-reply-send');
    box.addEventListener('click', function (ev) { ev.stopPropagation(); });
    send.addEventListener('click', function () { sendReply(row, id, textarea, send); });
    box.querySelector('.notif-reply-cancel').addEventListener('click', function () { closeReply(row); });
    textarea.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendReply(row, id, textarea, send); }
      if (ev.key === 'Escape') closeReply(row);
    });
    textarea.focus();
  }

  window.openInboxReply = openInboxReply;
}());
