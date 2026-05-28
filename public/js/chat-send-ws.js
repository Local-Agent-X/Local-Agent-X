// ── Chat: WebSocket streaming dispatch ──
// Fires the chat message and waits for ChatStreamStore to flip status to
// 'done' (or 'stopping' → 'done'). Per-event rendering is owned by the
// single dispatcher in chat-ws-handler.js / chat-ws-handler-chat-events.js;
// this module only handles per-turn lifecycle: send, persist, finalize.

function _sendMessageWs(ctx) {
  const { streamSessionId, streamChat, finalText, msgAttachments } = ctx;
  chatWs.send(JSON.stringify({
    type: 'chat',
    sessionId: streamSessionId,
    message: finalText,
    attachments: msgAttachments || [],
    projectId: streamChat.projectId || null,
  }));

  const saveInterval = setInterval(function() {
    const entry = ChatStreamStore.get(streamSessionId);
    if (!entry) return;
    if (!entry.content.trim() && entry.toolEvents.length === 0) return;
    _upsertStreamingAssistant(streamChat, entry.content, entry.toolEvents);
    streamChat.updatedAt = Date.now();
    saveChats();
  }, 3000);

  const unsubscribe = ChatStreamStore.subscribe(streamSessionId, function(entry, event) {
    if (!entry || entry.status !== 'done') return;
    unsubscribe();
    clearInterval(saveInterval);
    _finalizeWsTurn(streamSessionId, streamChat);
  });
}

function _finalizeWsTurn(streamSessionId, streamChat) {
  try { if (typeof window.updateStreamUI === 'function') window.updateStreamUI(); } catch {}
  try {
    const stopBtn2 = document.getElementById('stop-btn');
    if (stopBtn2) stopBtn2.style.display = 'none';
    document.getElementById('send-btn').disabled = false;
  } catch {}
  userScrolledUp = false;

  const entry = ChatStreamStore.get(streamSessionId);
  const finalContent = entry ? entry.content : '';
  const finalTools = entry ? entry.toolEvents : [];

  // Persist final message — preserve any content streamed during the turn.
  // Don't overwrite existing content with empty string (race with savePartial).
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

  // Final DOM sync — flush any pending rAF render so the last chunk of
  // content is visible. Re-resolve the bubble FRESH: a stale bodyEl from
  // earlier in the turn may be detached after a DOM rebuild (chat-switch+
  // back, or a layout re-render mid-stream). Live failure 2026-05-18:
  // assistant replies completed cleanly (Stop button hidden) but bubble
  // stayed empty until leave+return.
  const viewing = !!(activeChat && activeChat.id === streamSessionId);
  if (viewing) {
    const liveBubble = _findStreamingBodyEl(streamSessionId);
    const pending = liveBubble ? _streamRenderers.get(liveBubble) : null;
    if (pending && pending.raf) { cancelAnimationFrame(pending.raf); pending.raf = 0; }
    const paintText = (pending && pending.latest) || finalContent;
    if (liveBubble && paintText) {
      const existingGroups = liveBubble.querySelectorAll('.activity-group');
      const orphanCards = liveBubble.querySelectorAll(':scope > .tool-card, :scope > .approval-card');
      const mediaPreviews = liveBubble.querySelectorAll(':scope > .tool-media-preview');
      const currentMd = md(paintText);
      if (liveBubble.innerHTML !== currentMd || existingGroups.length > 0 || orphanCards.length > 0 || mediaPreviews.length > 0) {
        liveBubble.innerHTML = currentMd;
        mediaPreviews.forEach(m => liveBubble.appendChild(m));
        existingGroups.forEach(g => liveBubble.appendChild(g));
        orphanCards.forEach(c => liveBubble.appendChild(c));
      }
    } else {
      // No live bubble to paint into. The store + activeChat.messages already
      // hold the turn's text (saveInterval flushed it, or the persist branch
      // above pushed an assistant entry). renderMessages rebuilds the DOM
      // from that data. DO NOT hydrate here — hydrateChat does
      // Object.assign(chat, serverSession) which overwrites any in-flight or
      // recently-typed messages the server hasn't persisted yet. The
      // legitimate "server has content client doesn't" cases (WS reconnect
      // race, half-open) are already covered by reconnect_op replay
      // (chat-ws.js) and the heartbeat-driven reconnect path.
      if (typeof renderMessages === 'function') renderMessages();
    }
  }
  updateContextBar();
  flushTTS();
  if (typeof window.notifyTaskComplete === 'function') window.notifyTaskComplete(streamChat.title);
}
