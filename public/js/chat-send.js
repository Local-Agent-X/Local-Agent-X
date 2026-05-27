// ── Chat: sendMessage (start a chat turn or inject mid-stream) ──
//
// The single entrypoint for "user pressed send." Routes through:
//   1. Mid-stream inject — turn already running, push to inject queue
//   2. WebSocket stream  — chatWs is open and pong-healthy (chat-send-ws.js)
//   3. HTTP SSE fallback — WS not connected or stale  (chat-send-http.js)
//
// Pre-flight (attachments, bubble setup) lives here. Each dispatch path
// owns its own finalization; mutable stream state (content, toolEvents,
// bodyEl) is shared through the ctx object both paths receive.
//
// External deps:
//   - apiFetch, esc, AUTH_TOKEN, API   (shared.js)
//   - activeChat, saveChats, renderSidebar, newChat (app-state.js / app-sidebar-actions.js)
//   - streamingSessionId, _liveStreams, pendingUploads, userScrolledUp (chat.js)
//   - addMessageEl, _findStreamingBodyEl, renderMessages, renderUploadPreviews (chat-render.js / chat-uploads.js)
//   - feedTTS, flushTTS, stopSpeaking, ttsSentenceBuffer (chat-voice-tts.js)
//   - detectMood                       (chat-extras.js)

// [chat-diag] frontend → server log sink. Browser console doesn't
// persist; this POSTs to /api/diag/log so the breadcrumbs land in
// ~/.lax/logs/server.log. Fire-and-forget so it never blocks the chat
// path. Remove after the fresh-install chat bug is rooted out.
function _chatDiag(message) {
  try { console.log('[chat-diag]', message); } catch {}
  try {
    fetch('/api/diag/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (typeof AUTH_TOKEN !== 'undefined' ? AUTH_TOKEN : '') },
      body: JSON.stringify({ tag: 'chat-diag', message: String(message) }),
    }).catch(() => {});
  } catch {}
}

async function sendMessage() {
  const activeIsStreaming = !!(activeChat && _liveStreams.has(activeChat.id));
  _chatDiag('sendMessage entry activeIsStreaming=' + activeIsStreaming + ' streamingSessionId=' + streamingSessionId + ' activeChat?=' + !!activeChat + ' chatWs?=' + !!window.chatWs + ' wsReadyState=' + (window.chatWs ? window.chatWs.readyState : 'no-ws'));
  // Step 4 — interject during own-turn:
  // If the active chat is currently streaming (main agent mid-tool-loop),
  // the user's new message gets injected into the running turn instead of
  // starting a new one. Backend's interjectDrainMiddleware drains the
  // queue at the start of the next iteration so the agent sees it.
  if (activeIsStreaming) {
    _chatDiag('sendMessage taking inject path');
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
    // Echo locally as a user message so the chat reflects the interject
    // immediately without waiting for round-trip confirmation. `_queueState`
    // is set to 'queued' so renderMessages can apply the dimmed/pending
    // bubble style until the server's inject_consumed event arrives.
    activeChat.messages.push({ role: 'user', content: text, timestamp: Date.now(), _injected: true, _injectId: injectId, _queueState: 'queued' });
    if (typeof renderMessages === 'function') renderMessages();
    input.value = ''; input.style.height = 'auto';
    saveChats();
    return;
  }
  // No cross-session guard: if a DIFFERENT session is streaming (e.g. IDE
  // app-builder mid-turn while user switches to main chat), the active
  // chat can still send. Previously a singular streamingSessionId truthy
  // check here blocked all sends whenever any session streamed.
  userScrolledUp = false; // Reset scroll lock when user sends
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && pendingUploads.length === 0) return;
  // Wait for any in-flight uploads to finish before capturing attachments —
  // images need their server URL resolved, otherwise the backend filters them out
  // (see prepare-request.ts: `if (a.isImage && a.url)`).
  // Hard 8s ceiling per upload: a hung server (mid-restart) used to leave the
  // promise pending forever, blocking every subsequent send. The race below
  // either settles when uploads complete OR aborts the wait so we still try
  // to send (image will be url:null and the backend will skip it, but the
  // user's text reaches the agent rather than nothing).
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
  // ChatGPT-style scroll pin: addMessageEl already migrated `pin-bottom` to
  // the new assistant bubble (this one). Anchor the user prompt to the top.
  if (userMsgEl) {
    requestAnimationFrame(() => {
      try { userMsgEl.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch {}
    });
  }
  // Mark as streaming so the CSS adds a pulsing cursor + slight opacity
  // dim. Removed on `done`. Visual cue that text is still in flight so
  // mid-turn questions like "Want me to start?" don't read as final.
  try { bodyEl.classList.add('streaming'); } catch {}
  const streamSessionId = activeChat.id; // Capture which session THIS stream belongs to
  const streamChat = activeChat; // Reference to the chat object (survives navigation)
  window.streamingSessionId = streamSessionId; stopSpeaking(); ttsSentenceBuffer = '';
  // Track task start for browser notifications (feature 96)
  if (window.taskStartTime !== undefined) window.taskStartTime = Date.now();
  const stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.style.display = 'flex';
  // Step 4: keep send-btn ENABLED during streaming so user can type
  // interjects ("actually use blue", "also add Y"). sendMessage routes
  // through the inject path when _liveStreams.has(activeChat.id).
  document.getElementById('send-btn').disabled = false;

  // Feature 5: Mood detection — update indicator
  detectMood(text);

  // Shared mutable state for the dispatch path. Both _sendMessageWs and
  // _sendMessageHttp read+write through ctx so the inner switch cases can
  // mutate content/toolEvents and reassign bodyEl across module boundaries.
  const ctx = {
    streamSessionId,
    streamChat,
    finalText,
    msgAttachments,
    bodyEl,
    content: '',
    toolEvents: [],
    isViewingThis: () => activeChat && activeChat.id === streamSessionId,
    getBodyEl() {
      if (ctx.bodyEl && ctx.bodyEl.isConnected) return ctx.bodyEl;
      const fresh = _findStreamingBodyEl(streamSessionId);
      if (fresh) ctx.bodyEl = fresh;
      return ctx.bodyEl && ctx.bodyEl.isConnected ? ctx.bodyEl : null;
    },
  };

  // Register so renderMessages can pull live state when re-entering this chat
  _liveStreams.set(streamSessionId, { get content() { return ctx.content; }, get toolEvents() { return ctx.toolEvents; } });

  // WS pong-staleness check is the front-line defense against half-open
  // connections: even with readyState=OPEN, if we haven't seen a {type:"pong"}
  // reply since the connection opened the WS may be dead — demote to HTTP.
  //
  // Require chatWsLastPong > 0 (sentinel for "no pong yet"). Without this
  // the first send after page-load went via WS even when the connection
  // was half-open from the start — that was the 2026-05-17 fresh-install
  // chat-doesnt-work-until-Cmd-R bug. The heartbeat sends an immediate
  // ping on open, so a healthy connection has lastPong > 0 within a few
  // ms of connection-up.
  const wsLastPong = typeof window.chatWsLastPong === 'number' ? window.chatWsLastPong : 0;
  const wsHealthy = chatWs && chatWs.readyState === WebSocket.OPEN && wsLastPong > 0 && (Date.now() - wsLastPong < 40_000);
  if (wsHealthy) {
    _chatDiag('sendMessage dispatching via WS sess=' + streamSessionId.slice(-8) + ' len=' + finalText.length + ' pongAge=' + (Date.now() - wsLastPong) + 'ms');
    _sendMessageWs(ctx);
    return;
  }

  _chatDiag('sendMessage dispatching via HTTP fallback sess=' + streamSessionId.slice(-8) + ' wsReadyState=' + (chatWs ? chatWs.readyState : 'no-ws'));
  await _sendMessageHttp(ctx);
}
