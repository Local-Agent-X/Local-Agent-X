// ── Chat: sendMessage (start a chat turn or inject mid-stream) ──
//
// The single entrypoint for "user pressed send." Routes through:
//   1. Mid-stream inject — turn already running, push to inject queue
//   2. WebSocket stream  — chatWs is open and pong-healthy (chat-send-ws.js)
//   3. HTTP SSE fallback — WS not connected or stale  (chat-send-http.js)
//
// Pre-flight (attachments, bubble setup, store.startTurn) lives here.
// Per-session stream state (content / toolEvents / opId / status) is held
// in ChatStreamStore (chat-stream-store.js); each dispatch path reads
// from the store rather than holding its own closure-bound buffer.
//
// External deps:
//   - apiFetch, esc, AUTH_TOKEN, API   (shared.js)
//   - activeChat, saveChats, renderSidebar, newChat (app-state.js / app-sidebar-actions.js)
//   - pendingUploads, userScrolledUp   (chat.js)
//   - ChatStreamStore                  (chat-stream-store.js)
//   - addMessageEl, _findStreamingBodyEl, renderMessages, renderUploadPreviews
//                                      (chat-render.js / chat-uploads.js)
//   - feedTTS, flushTTS, stopSpeaking, ttsSentenceBuffer (chat-voice-tts.js)
//   - detectMood                       (chat-extras.js)

async function sendMessage() {
  const activeIsStreaming = !!(activeChat && ChatStreamStore.isStreaming(activeChat.id));
  // Step 4 — interject during own-turn:
  // If the active chat is currently streaming (main agent mid-tool-loop),
  // the user's new message gets injected into the running turn instead of
  // starting a new one. Backend's interjectDrainMiddleware drains the
  // queue at the start of the next iteration so the agent sees it.
  if (activeIsStreaming) {
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    if (!text) return;
    // Client-generated ID so the local echo can be correlated with the
    // server's inject_consumed event (which drops the "queued" styling).
    const injectId = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : ('inj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'inject', sessionId: activeChat.id, message: text, injectId }));
    }
    const injectMsg = { role: 'user', content: text, timestamp: Date.now(), _injected: true, _injectId: injectId, _queueState: 'queued' };
    // Push to end. The live assistant row isn't in messages[] during a turn
    // (Phase 1 refactor) — it's synthesized by renderMessages at the store's
    // liveAnchorIndex. So the inject naturally lands after the synthetic
    // live row without needing to walk back over any streaming slot.
    activeChat.messages.push(injectMsg);
    if (typeof renderMessages === 'function') renderMessages();
    input.value = ''; input.style.height = 'auto';
    saveChats();
    return;
  }
  // No cross-session guard: if a DIFFERENT session is streaming (e.g. IDE
  // app-builder mid-turn while user switches to main chat), the active
  // chat can still send. Per-session via the store — a singular pointer
  // here used to block all sends whenever any session streamed.
  userScrolledUp = false;
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && pendingUploads.length === 0) return;
  // Wait for any in-flight uploads to finish before capturing attachments.
  // Hard 8s ceiling per upload: a hung server (mid-restart) used to leave
  // the promise pending forever, blocking every subsequent send.
  const inflight = pendingUploads.filter(f => f._uploadPromise).map(f => f._uploadPromise);
  if (inflight.length > 0) {
    await Promise.race([
      Promise.all(inflight),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
  }
  // Capture attachments before clearing
  const msgAttachments = pendingUploads.length ? pendingUploads.map(f => ({
    name: f.name, size: f.size, type: f.type, isImage: f.isImage,
    url: f.url || null, dataUrl: f.dataUrl || null
  })) : null;
  const hasImages = msgAttachments && msgAttachments.some(a => a.isImage);
  const nonImageFiles = msgAttachments ? msgAttachments.filter(a => !a.isImage) : [];
  const uploadPrefix = nonImageFiles.length
    ? `Attached files:\n${nonImageFiles.map(f => `- ${f.name} (${f.size} bytes)`).join('\n')}\n\n`
    : (hasImages && !text ? '' : '');
  const finalText = uploadPrefix + text;
  const displayText = text || '';
  input.value = ''; input.style.height = 'auto';
  pendingUploads = []; renderUploadPreviews();
  if (!activeChat) newChat();
  if (activeChat.messages.length === 0) {
    const titleSrc = text || (msgAttachments ? msgAttachments[0].name : 'New Chat');
    activeChat.title = titleSrc.slice(0, 50) + (titleSrc.length > 50 ? '...' : '');
    saveChats(); renderSidebar();
  }
  const empty = document.getElementById('empty'); if (empty) empty.remove();
  const msgTime = Date.now();
  const userMsgEl = addMessageEl('user', displayText, msgAttachments, msgTime);
  activeChat.messages.push({ role: 'user', content: finalText, attachments: msgAttachments, timestamp: msgTime });
  const msgEl = addMessageEl('assistant', '');
  let bodyEl = msgEl.querySelector('.msg-body');
  bodyEl.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
  // ChatGPT-style scroll pin: anchor the user prompt to the top.
  if (userMsgEl) {
    requestAnimationFrame(() => {
      try { userMsgEl.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch {}
    });
  }
  // Visual cue that text is still in flight so mid-turn questions like
  // "Want me to start?" don't read as final.
  try { bodyEl.classList.add('streaming'); } catch {}
  const streamSessionId = activeChat.id;
  const streamChat = activeChat;
  ChatStreamStore.startTurn(streamSessionId, streamChat.messages.length);
  stopSpeaking(); ttsSentenceBuffer = '';
  if (window.taskStartTime !== undefined) window.taskStartTime = Date.now();
  const stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.style.display = 'flex';
  // Step 4: keep send-btn ENABLED during streaming so user can type
  // interjects ("actually use blue", "also add Y"). sendMessage routes
  // through the inject path when the active chat is streaming.
  document.getElementById('send-btn').disabled = false;

  detectMood(text);

  const ctx = {
    streamSessionId,
    streamChat,
    finalText,
    msgAttachments,
    isViewingThis: () => activeChat && activeChat.id === streamSessionId,
  };

  // WS pong-staleness check is the front-line defense against half-open
  // connections: even with readyState=OPEN, if we haven't seen a pong reply
  // since the connection opened the WS may be dead — demote to HTTP.
  //
  // Require chatWsLastPong > 0 (sentinel for "no pong yet"). Without this
  // the first send after page-load went via WS even when the connection
  // was half-open from the start — that was the 2026-05-17 fresh-install
  // chat-doesnt-work-until-Cmd-R bug.
  const wsLastPong = typeof window.chatWsLastPong === 'number' ? window.chatWsLastPong : 0;
  const wsHealthy = chatWs && chatWs.readyState === WebSocket.OPEN && wsLastPong > 0 && (Date.now() - wsLastPong < 40_000);
  if (wsHealthy) {
    _sendMessageWs(ctx);
    return;
  }
  await _sendMessageHttp(ctx);
}
