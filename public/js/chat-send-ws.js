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

  // No mid-stream save tick — the live row lives in ChatStreamStore until
  // finalize, where promoteLiveToMessages atomically splices it into
  // messages[] at the captured anchor. saveChats on `done` is the single
  // persistence point.
  const unsubscribe = ChatStreamStore.subscribe(streamSessionId, function(entry, event) {
    if (!entry || entry.status !== 'done') return;
    unsubscribe();
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

  // Promote the live row from the store into chat.messages at the anchor
  // captured at startTurn. Single persistence point — no race with a mid-
  // stream save tick because there is no save tick.
  const finalized = ChatStreamStore.promoteLiveToMessages(streamSessionId, streamChat);
  if (!finalized) {
    // Nothing to promote — either a turn that produced no output, or a
    // redundant `done` replayed by the stuck-stream watchdog after the row
    // was already finalized (promoteLiveToMessages is idempotent and now
    // returns null on the second call). Skip the persist + rebuild so we
    // don't re-paint or re-save for a no-op finalize.
    return;
  }
  streamChat.updatedAt = Date.now();
  saveChats();
  renderSidebar();
  // messages[] now holds the finalized assistant row (promoteLiveToMessages
  // just spliced it in). Swap ONLY the live bubble in place — a full
  // renderMessages() here wipes and rebuilds the entire thread, which is the
  // flash the user sees on every completed turn. Fall back to a full render
  // only if the live node can't be located.
  const viewing = !!(activeChat && activeChat.id === streamSessionId);
  if (viewing) {
    if (!finalizeLiveMessageInPlace(streamSessionId, finalized) && typeof renderMessages === 'function') {
      renderMessages();
    }
  }
  updateContextBar();
  flushTTS();
  if (typeof window.notifyTaskComplete === 'function') window.notifyTaskComplete(streamChat.title);
}
