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
    let lastSaveTime = 0;

    function savePartial() {
      const entry = ChatStreamStore.get(streamSessionId);
      if (!entry || (!entry.content.trim() && entry.toolEvents.length === 0)) return;
      _upsertStreamingAssistant(streamChat, entry.content, entry.toolEvents);
      streamChat.updatedAt = Date.now();
      saveChats();
    }

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
          if (event.type === 'tool_end' || (event.type === 'stream' && Date.now() - lastSaveTime > 2000)) {
            savePartial();
            lastSaveTime = Date.now();
          }
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
      const e2 = ChatStreamStore.get(streamSessionId);
      if (e2 && (e2.content.trim() || e2.toolEvents.length)) {
        _upsertStreamingAssistant(streamChat, e2.content, e2.toolEvents);
        streamChat.updatedAt = Date.now(); saveChats();
      }
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
  ChatStreamStore.endTurn(streamSessionId, null);

  const entry = ChatStreamStore.get(streamSessionId);
  const finalContent = entry ? entry.content : '';
  const finalTools = entry ? entry.toolEvents : [];

  const lastMsg = streamChat.messages[streamChat.messages.length - 1];
  if (lastMsg && lastMsg._streaming) {
    if (finalContent && finalContent.length >= (lastMsg.content || '').length) {
      lastMsg.content = finalContent;
    }
    lastMsg._tools = finalTools.length > 0 ? [...finalTools] : undefined;
    lastMsg.timestamp = Date.now();
    delete lastMsg._streaming;
    streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
  } else if (finalContent.trim()) {
    streamChat.messages.push({ role: 'assistant', content: finalContent, timestamp: Date.now() });
    streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
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
      if (!finalContent.trim() && typeof hydrateChat === 'function') {
        streamChat._needsHydrate = true;
        hydrateChat(streamChat).catch(e => console.warn('[chat] done-time hydrate failed (HTTP path):', e && e.message));
      }
    }
    updateContextBar();
  } catch (renderErr) { console.error('[chat] finalize render error:', renderErr); }
}
