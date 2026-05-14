// ── Chat: sendMessage (start a chat turn or inject mid-stream) ──
//
// The single entrypoint for "user pressed send." Routes the message through
// one of three paths:
//   1. Mid-stream inject  — turn already running, push to inject queue
//   2. WebSocket          — chat WS open, stream over WS
//   3. HTTP SSE fallback  — WS not connected, hit /api/chat
//
// Owns the per-stream closures (content / toolEvents) and registers them
// into _liveStreams so the renderer can re-bind after a chat switch.
//
// Extracted from chat.js as part of the 400-LOC god-file split.
//
// External deps from chat.js / shared.js / other modules:
//   - apiFetch, esc, AUTH_TOKEN, API   (shared.js)
//   - activeChat, saveChats, renderSidebar, newChat (app.js)
//   - streamingSessionId, _liveStreams, pendingUploads, userScrolledUp
//                                       (chat.js — closure-bound at call time)
//   - addMessageEl, _upsertStreamingAssistant, renderMessages, autoScroll,
//     renderUploadPreviews              (chat.js / chat-render.js — auto-window)
//   - feedTTS, flushTTS, stopSpeaking   (chat-voice.js)
//   - addAgentFeed, updateAgentFeed     (chat-agent-feeds.js)
//   - appendToolCardGrouped, appendToolChip, makeApprovalCard,
//     updateToolProgress                (chat-tool-cards.js)
//   - showSecretModal, showMultiSecretModal (secret-modal.js)
//   - updateContextBar, updateSmartContextIndicator (chat-status-bar.js / chat-extras.js)

async function sendMessage() {
  // Step 4 — interject during own-turn:
  // If the active chat is currently streaming (main agent mid-tool-loop),
  // the user's new message gets injected into the running turn instead of
  // starting a new one. Backend's interjectDrainMiddleware drains the
  // queue at the start of the next iteration so the agent sees it.
  if (streamingSessionId && activeChat && streamingSessionId === activeChat.id) {
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    if (!text) return;
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'inject', sessionId: activeChat.id, message: text }));
    }
    // Echo locally as a user message so the chat reflects the interject
    // immediately without waiting for round-trip confirmation.
    activeChat.messages.push({ role: 'user', content: text, timestamp: Date.now(), _injected: true });
    if (typeof renderMessages === 'function') renderMessages();
    input.value = ''; input.style.height = 'auto';
    saveChats();
    return;
  }
  if (streamingSessionId) return;
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
  streamingSessionId = streamSessionId; stopSpeaking(); ttsSentenceBuffer = '';
  // Track task start for browser notifications (feature 96)
  if (window.taskStartTime !== undefined) window.taskStartTime = Date.now();
  const stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.style.display = 'flex';
  // Step 4: keep send-btn ENABLED during streaming so user can type
  // interjects ("actually use blue", "also add Y"). sendMessage routes
  // through the inject path when streamingSessionId === activeChat.id.
  document.getElementById('send-btn').disabled = false;

  // Helper: is the user still viewing this chat?
  function isViewingThis() { return activeChat && activeChat.id === streamSessionId; }

  // Resolve the streaming bodyEl dynamically so chat-switch-and-back reattaches.
  // The originally-captured bodyEl gets detached when renderMessages rebuilds
  // the DOM for the other chat. When we come back, renderMessages creates a
  // fresh bodyEl — this helper finds it.
  function getBodyEl() {
    if (bodyEl && bodyEl.isConnected) return bodyEl;
    const fresh = _findStreamingBodyEl(streamSessionId);
    if (fresh) bodyEl = fresh;
    return bodyEl && bodyEl.isConnected ? bodyEl : null;
  }

  // Feature 5: Mood detection — update indicator
  detectMood(text);

  let content = '';
  let toolEvents = [];

  // Register so renderMessages can pull live state when re-entering this chat
  _liveStreams.set(streamSessionId, { get content() { return content; }, get toolEvents() { return toolEvents; } });

  // Try WebSocket first (bidirectional, no SSE buffering issues)
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ type: 'chat', sessionId: streamSessionId, message: finalText, attachments: msgAttachments || [], projectId: streamChat.projectId || null }));
    // Events arrive via the WS onmessage handler (lines above) which calls broadcastToSession
    // Set up a WS event listener for this session's stream events
    const wsHandler = function(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'event' || msg.sessionId !== streamSessionId) return;
        const event = msg.event;
        const viewing = isViewingThis();
        // [stream-debug] TEMP — diagnosing bug C (events arrive but DOM
        // doesn't update until reload, or massive lag). Logs every event
        // arrival with timing + viewing/bodyEl state so we can tell whether
        // events are arriving slowly (server/upstream cadence) or being
        // dropped at the renderer (chat-layer bug). Filter the console
        // with `[stream-debug]` to see only these lines. Remove after diagnosis.
        if (event.type === 'stream' || event.type === 'tool_start' || event.type === 'tool_end' || event.type === 'done') {
          const bodyConnected = bodyEl ? document.contains(bodyEl) : 'no-bodyEl';
          const deltaLen = event.type === 'stream' ? (event.delta || '').length : '';
          console.log(`[stream-debug] t=${Date.now()} evt=${event.type} viewing=${viewing} bodyConnected=${bodyConnected} deltaLen=${deltaLen} sess=${streamSessionId.slice(-8)}`);
        }
        // If we're viewing, make sure bodyEl points to a connected DOM node.
        // After a chat-switch-and-back, the originally-captured bodyEl is
        // detached and renderMessages has rendered a fresh one.
        if (viewing) getBodyEl();
        switch (event.type) {
          case 'stream':
            // stream_redact: adapter post-processed (extracted a tool call
            // from text the model emitted as JSON). Replace bubble content
            // with the cleaned text instead of appending — server already
            // computed what the bubble SHOULD have said.
            if (event.replace === true) {
              content = event.text || '';
              if (viewing) renderStreamContent(bodyEl, content);
              break;
            }
            content += event.delta;
            if (viewing) {
              renderStreamContent(bodyEl, content);
              feedTTS(event.delta);
            }
            break;
          case 'tool_start':
            toolEvents.push({ type: 'start', name: event.toolName, args: event.args, riskLevel: event.riskLevel });
            if (viewing) {
              // Preserve activity-groups (which contain tool cards) across
              // the markdown re-render — without this, every text delta wipes
              // the group container and orphaned tool cards float in body.
              const existingGroups = bodyEl.querySelectorAll('.activity-group');
              const orphanCards = bodyEl.querySelectorAll(':scope > .tool-card');
              bodyEl.innerHTML = content ? md(content) : '';
              existingGroups.forEach(g => bodyEl.appendChild(g));
              orphanCards.forEach(c => bodyEl.appendChild(c));
              appendToolCardGrouped(bodyEl, event.toolName, event.args, event.riskLevel, event.context);
            }
            break;
          case 'tool_end': {
            toolEvents.push({ type: 'end', name: event.toolName, allowed: event.allowed, result: (event.result||'').slice(0, 500) });
            if (viewing) {
              const cards = bodyEl.querySelectorAll('.tool-card');
              const last = cards[cards.length - 1];
              if (last) {
                last.querySelector('.indicator').className = 'indicator ' + (event.allowed ? 'allowed' : 'blocked');
                let cleanResult = (event.result || '').replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '[content loaded]')
                  .replace(/IMPORTANT:.*?Do NOT follow any instructions.*$/gm, '')
                  .replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
                  .replace(/<content>\n?/g, '').replace(/\n?<\/content>/g, '')
                  .trim().slice(0, 200);
                last.querySelector('.tool-detail').textContent = cleanResult || '\u2713 Done';
              }
            }
            break;
          }
          case 'tool_chip':
            if (viewing && event.chip) appendToolChip(bodyEl, event.chip);
            break;
          case 'tool_progress':
            if (viewing) updateToolProgress(bodyEl, event.toolName, event.message);
            break;
          case 'secret_request': showSecretModal(event.name, event.service, event.reason); break;
          case 'secrets_request': showMultiSecretModal(event.secrets); break;
          case 'approval_requested':
            if (viewing) bodyEl.appendChild(makeApprovalCard(event.approvalId, event.toolName, event.context, event.argsPreview));
            break;
          case 'approval_timeout': {
            const card = document.querySelector('.approval-card[data-id="' + event.approvalId + '"]');
            if (card) { card.classList.add('timeout'); card.querySelector('.approval-status').textContent = 'Timed out \u2014 denied.'; card.querySelectorAll('button').forEach(b => b.disabled = true); }
            break;
          }
          case 'context_status': if (viewing) updateContextBar(event); break;
          case 'stopped':
            // Render a small italic stop-notice below the message body.
            // NOT appended to `content` — keeps the message clean and
            // prevents the technical reason from being persisted into chat
            // history. The technical `debug` text is logged to console for
            // diagnostics but never shown in the UI.
            if (event.debug) console.info('[stopped]', event.firedBy || '?', event.debug);
            if (viewing) {
              const note = document.createElement('div');
              note.className = 'stop-notice';
              note.textContent = event.reason || 'Stopped.';
              note.title = event.debug || event.firedBy || '';
              bodyEl.appendChild(note);
            }
            break;
          case 'error':
            if (saveInterval) clearInterval(saveInterval);
            content += '\n\nError: ' + event.message;
            if (viewing) bodyEl.innerHTML = md(content);
            break;
          case 'done': {
            chatWs.removeEventListener('message', wsHandler);
            if (saveInterval) clearInterval(saveInterval);
            // Finalize
            if (streamingSessionId === streamSessionId) streamingSessionId = null;
            _liveStreams.delete(streamSessionId);
            // Keep `pin-bottom` — it's the latest turn and should retain the
            // viewport-height reserved space below until the user sends again.
            try {
              const stopBtn2 = document.getElementById('stop-btn');
              if (stopBtn2) stopBtn2.style.display = 'none';
              document.getElementById('send-btn').disabled = false;
            } catch {}
            userScrolledUp = false;
            const lastMsg = streamChat.messages[streamChat.messages.length - 1];
            // Persist final message — preserve any content that was streamed/saved during the turn.
            // Don't overwrite existing content with empty string (race with savePartial interval).
            if (lastMsg && lastMsg._streaming) {
              if (content && content.length >= (lastMsg.content || '').length) {
                lastMsg.content = content;
              }
              lastMsg.timestamp = Date.now();
              delete lastMsg._streaming;
              streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
            } else if (content.trim()) {
              streamChat.messages.push({ role: 'assistant', content, timestamp: Date.now() });
              streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
            }
            // Final DOM sync — flush any pending rAF render so the last chunk
            // of content is visible, but DO NOT call renderMessages() which
            // blows away the entire message list and causes a visible blink.
            // The streaming bodyEl already has the full content from
            // renderStreamContent; we only need to ensure the final frame landed.
            if (isViewingThis()) {
              const pending = _streamRenderers.get(bodyEl);
              if (pending && pending.raf) {
                // rAF is pending — force it to flush now synchronously
                cancelAnimationFrame(pending.raf);
                pending.raf = 0;
                const existingGroups = bodyEl.querySelectorAll('.activity-group');
                const orphanCards = bodyEl.querySelectorAll(':scope > .tool-card, :scope > .approval-card');
                bodyEl.innerHTML = pending.latest ? md(pending.latest) : '';
                existingGroups.forEach(g => bodyEl.appendChild(g));
                orphanCards.forEach(c => bodyEl.appendChild(c));
              } else if (content && bodyEl) {
                // No pending rAF — ensure DOM has latest content (in case last
                // delta arrived on the same tick as 'done')
                const existingGroups = bodyEl.querySelectorAll('.activity-group');
                const orphanCards = bodyEl.querySelectorAll(':scope > .tool-card, :scope > .approval-card');
                const currentMd = md(content);
                if (bodyEl.innerHTML !== currentMd || existingGroups.length > 0 || orphanCards.length > 0) {
                  bodyEl.innerHTML = currentMd;
                  existingGroups.forEach(g => bodyEl.appendChild(g));
                  orphanCards.forEach(c => bodyEl.appendChild(c));
                }
              }
            }
            updateContextBar();
            flushTTS();
            if (typeof window.notifyTaskComplete === 'function') window.notifyTaskComplete(streamChat.title);
            break;
          }
        }
        // No post-event auto-scroll. The user message was pinned to the top of
        // the viewport at send time, the assistant bubble reserves room below,
        // and the reader stays in control of scroll throughout (and after).
      } catch {}
    };
    chatWs.addEventListener('message', wsHandler);
    // Save partial periodically. Use the shared upsert helper so a mid-turn
    // inject (which pushes a user row AFTER the streaming assistant) doesn't
    // trick this branch into appending a SECOND streaming-assistant entry —
    // the bug that made the user's bubble appear sandwiched between two
    // copies of the assistant's growing reply.
    const saveInterval = setInterval(function() {
      if (!content.trim() && toolEvents.length === 0) return;
      _upsertStreamingAssistant(streamChat, content, toolEvents);
      streamChat.updatedAt = Date.now(); saveChats();
    }, 3000);
    // Clean up save interval when done
    const origHandler = wsHandler;
    // We rely on the 'done' event above to clean up
    return; // Don't fall through to HTTP
  }

  // Fallback: HTTP SSE (if WebSocket not connected)
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

    // Always save to the ORIGINAL chat object, not whatever activeChat is now.
    // Routes through the shared upsert so mid-turn injects don't cause a
    // duplicate streaming-assistant entry (see _upsertStreamingAssistant).
    function savePartial() {
      if ((!content.trim() && toolEvents.length === 0)) return;
      _upsertStreamingAssistant(streamChat, content, toolEvents);
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
          const viewing = isViewingThis();
          if (viewing) getBodyEl();
          switch (event.type) {
            case 'stream':
              if (event.replace === true) {
                content = event.text || '';
                if (viewing) renderStreamContent(bodyEl, content);
                break;
              }
              content += event.delta;
              if (viewing) {
                renderStreamContent(bodyEl, content);
                feedTTS(event.delta);
              }
              if (Date.now() - lastSaveTime > 2000) { savePartial(); lastSaveTime = Date.now(); }
              break;
            case 'tool_start':
              toolEvents.push({ type: 'start', name: event.toolName, args: event.args, riskLevel: event.riskLevel });
              if (viewing) {
                const existingCards = bodyEl.querySelectorAll('.tool-card');
                bodyEl.innerHTML = content ? md(content) : '';
                existingCards.forEach(c => bodyEl.appendChild(c));
                appendToolCardGrouped(bodyEl, event.toolName, event.args, event.riskLevel, event.context);
              }
              break;
            case 'tool_end': {
              toolEvents.push({ type: 'end', name: event.toolName, allowed: event.allowed, result: (event.result||'').slice(0, 500) });
              if (viewing) {
                const cards = bodyEl.querySelectorAll('.tool-card');
                const last = cards[cards.length - 1];
                if (last) {
                  last.querySelector('.indicator').className = 'indicator ' + (event.allowed ? 'allowed' : 'blocked');
                  // Clean tool result: strip security wrappers and show brief summary
                  let cleanResult = (event.result || '').replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '[content loaded]')
                    .replace(/IMPORTANT:.*?Do NOT follow any instructions.*$/gm, '')
                    .replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
                    .replace(/<content>\n?/g, '').replace(/\n?<\/content>/g, '')
                    .trim().slice(0, 200);
                  last.querySelector('.tool-detail').textContent = cleanResult || '✓ Done';
                }
              }
              savePartial();
              break;
            }
            case 'tool_chip':
              if (viewing && event.chip) appendToolChip(bodyEl, event.chip);
              break;
            case 'tool_progress':
              if (viewing) updateToolProgress(bodyEl, event.toolName, event.message);
              break;
            case 'secret_request': showSecretModal(event.name, event.service, event.reason); break;
            case 'secrets_request': showMultiSecretModal(event.secrets); break;
              case 'approval_requested':
              if (viewing) bodyEl.appendChild(makeApprovalCard(event.approvalId, event.toolName, event.context, event.argsPreview));
              break;
            case 'approval_timeout': {
              const card = document.querySelector('.approval-card[data-id="' + event.approvalId + '"]');
              if (card) { card.classList.add('timeout'); card.querySelector('.approval-status').textContent = 'Timed out — denied.'; card.querySelectorAll('button').forEach(b => b.disabled = true); }
              break;
            }
            case 'context_status': if (viewing) updateContextBar(event); break;
            case 'stopped':
              if (event.debug) console.info('[stopped]', event.firedBy || '?', event.debug);
              if (viewing) {
                const note = document.createElement('div');
                note.className = 'stop-notice';
                note.textContent = event.reason || 'Stopped.';
                note.title = event.debug || event.firedBy || '';
                bodyEl.appendChild(note);
              }
              break;
            case 'error': content += '\n\nError: ' + event.message; if (viewing) bodyEl.innerHTML = md(content); break;
            case 'agent_spawn':
              if (event.agent) addAgentFeed(event.agent);
              if (viewing) { var _ac = document.createElement('div'); _ac.innerHTML = renderAgentCard_inline(event.agent); bodyEl.appendChild(_ac.firstChild); }
              break;
            case 'agent_status':
              if (event.agentId) updateAgentFeed(event.agentId, event);
              if (viewing && event.agent) { var _as = document.createElement('div'); _as.innerHTML = renderAgentCard_inline(event.agent); bodyEl.appendChild(_as.firstChild); }
              break;
          }
        } catch {}
      }
      // No post-event auto-scroll (see WS handler comment above).
    }
    userScrolledUp = false;
    // Finalize the ORIGINAL chat — preserve streamed content; don't lose visible bubbles
    const lastMsg = streamChat.messages[streamChat.messages.length - 1];
    if (lastMsg && lastMsg._streaming) {
      if (content && content.length >= (lastMsg.content || '').length) {
        lastMsg.content = content;
      }
      lastMsg.timestamp = Date.now();
      delete lastMsg._streaming;
      streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
    } else if (content.trim()) {
      streamChat.messages.push({ role: 'assistant', content, timestamp: Date.now() });
      streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
    }
    // If user navigated back, re-render to show completed response
    if (isViewingThis()) renderMessages();
  } catch (e) {
    // Silent auto-retry up to 3 times on network errors before showing error to user
    if (!content && e.message && (e.message.includes('network') || e.message.includes('Failed to fetch') || e.message.includes('CONNECTION'))) {
      let retrySuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (isViewingThis()) bodyEl.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
          await new Promise(r => setTimeout(r, attempt * 2000)); // 2s, 4s, 6s backoff
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
                if (event.type === 'stream') { content += event.delta; if (isViewingThis()) bodyEl.innerHTML = md(content); }
                if (event.type === 'tool_start' && isViewingThis()) { bodyEl.innerHTML = content ? md(content) : ''; appendToolCardGrouped(bodyEl, event.toolName, event.args, event.riskLevel, event.context); }
                if (event.type === 'tool_end' && isViewingThis()) { const cards = bodyEl.querySelectorAll('.tool-card'); const last = cards[cards.length-1]; if(last){last.querySelector('.indicator').className='indicator '+(event.allowed?'allowed':'blocked');} }
                if (event.type === 'tool_progress' && isViewingThis()) { updateToolProgress(bodyEl, event.toolName, event.message); }
                if (event.type === 'done') { savePartial(); }
              } catch {}
            }
          }
          retrySuccess = true;
          break;
        } catch { /* retry */ }
      }
      if (!retrySuccess && isViewingThis()) showRetryError(bodyEl, finalText, e.message);
    } else {
      if (isViewingThis()) showRetryError(bodyEl, finalText, e.message);
    }
  }
  flushTTS();
  // Browser notification for completed long tasks (feature 96)
  if (typeof window.notifyTaskComplete === 'function') window.notifyTaskComplete(streamChat.title);
  // ALWAYS clear streaming state — must happen before anything that could throw
  if (streamingSessionId === streamSessionId) streamingSessionId = null;
  _liveStreams.delete(streamSessionId);
  // pin-bottom stays — see WS-handler note. Latest turn keeps reserved height.
  // Always hide stop button and re-enable send when stream ends
  try {
    const stopBtn2 = document.getElementById('stop-btn');
    if (stopBtn2) stopBtn2.style.display = 'none';
    document.getElementById('send-btn').disabled = false;
    if (isViewingThis()) renderMessages();
    updateContextBar();
  } catch (renderErr) { console.error('[chat] finalize render error:', renderErr); }
}

