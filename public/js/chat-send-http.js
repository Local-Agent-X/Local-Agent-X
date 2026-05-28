// ── Chat: HTTP SSE streaming dispatch ──
// Mirrors the WS path: each SSE event is funnelled through
// dispatchChatStreamEvent so per-session state lives in ChatStreamStore
// (same as the WS dispatcher). The reader loop owns its own retry and its
// own finalize — SSE has no terminal `done` event; end-of-stream IS the
// signal, so we synthesize the done via store.endTurn.

async function _sendMessageHttp(ctx) {
  const { streamSessionId, streamChat, finalText, msgAttachments } = ctx;
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ message: finalText, sessionId: streamSessionId, attachments: msgAttachments || [], projectId: streamChat.projectId || null }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // No mid-stream save tick — the live row lives in ChatStreamStore until
    // _finalizeHttpTurn promotes it into messages[]. The store accumulates
    // content + toolEvents as events arrive; that's the single source of
    // truth during the turn.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          dispatchChatStreamEvent({ sessionId: streamSessionId, event });
        } catch {}
      }
    }
    userScrolledUp = false;
  } catch (e) {
    await _retryHttpStream(ctx, e);
  }
  _finalizeHttpTurn(ctx, streamSessionId, streamChat);
}

async function _retryHttpStream(ctx, originalErr) {
  const { streamSessionId, streamChat, finalText, msgAttachments } = ctx;
  const entry = ChatStreamStore.get(streamSessionId);
  const hasContent = !!(entry && entry.content);
  const isNetworkErr = originalErr.message && (originalErr.message.includes('network') || originalErr.message.includes('Failed to fetch') || originalErr.message.includes('CONNECTION'));
  if (hasContent || !isNetworkErr) {
    const bodyEl = ctx.isViewingThis() ? _findStreamingBodyEl(streamSessionId) : null;
    if (bodyEl) showRetryError(bodyEl, finalText, originalErr.message);
    return;
  }
  let retrySuccess = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const bodyEl = ctx.isViewingThis() ? _findStreamingBodyEl(streamSessionId) : null;
      if (bodyEl) bodyEl.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
      await new Promise(r => setTimeout(r, attempt * 2000));
      const res2 = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({ message: finalText, sessionId: streamSessionId, attachments: msgAttachments || [], projectId: streamChat.projectId || null }),
      });
      const reader2 = res2.body.getReader();
      const decoder2 = new TextDecoder();
      let buffer2 = '';
      while (true) {
        const { done, value } = await reader2.read();
        if (done) break;
        buffer2 += decoder2.decode(value, { stream: true });
        const lines = buffer2.split('\n'); buffer2 = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            dispatchChatStreamEvent({ sessionId: streamSessionId, event });
          } catch {}
        }
      }
      // _finalizeHttpTurn handles promote + saveChats — don't double-write.
      retrySuccess = true;
      break;
    } catch { /* retry */ }
  }
  if (!retrySuccess) {
    const bodyEl = ctx.isViewingThis() ? _findStreamingBodyEl(streamSessionId) : null;
    if (bodyEl) showRetryError(bodyEl, finalText, originalErr.message);
  }
}

function _finalizeHttpTurn(ctx, streamSessionId, streamChat) {
  // Synthesize the terminal done — SSE doesn't send one; end-of-stream is
  // the signal. Drives subscribers + flips status so isStreaming flips false.
  // Must run BEFORE promoteLiveToMessages because the promote clears the
  // anchor; nothing reads status here but isStreaming is gated on it for
  // the next renderMessages call.
  ChatStreamStore.endTurn(streamSessionId, null);

  const finalized = ChatStreamStore.promoteLiveToMessages(streamSessionId, streamChat);
  if (finalized) {
    streamChat.updatedAt = Date.now();
    saveChats();
    renderSidebar();
  }

  flushTTS();
  if (typeof window.notifyTaskComplete === 'function') window.notifyTaskComplete(streamChat.title);
  try { if (typeof window.updateStreamUI === 'function') window.updateStreamUI(); } catch {}
  try {
    const stopBtn2 = document.getElementById('stop-btn');
    if (stopBtn2) stopBtn2.style.display = 'none';
    document.getElementById('send-btn').disabled = false;
    if (ctx.isViewingThis()) {
      renderMessages();
      // Do NOT hydrate here. hydrateChat does Object.assign(chat, serverSession)
      // which overwrites in-flight / recently-typed local messages the server
      // hasn't persisted yet — observed dropping 2 messages mid-conversation.
      // The store + activeChat.messages already hold the truth; renderMessages
      // is sufficient. Mirrors the WS-path fix.
    }
    updateContextBar();
  } catch (renderErr) { console.error('[chat] finalize render error:', renderErr); }
}
